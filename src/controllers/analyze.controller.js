const { Groq } = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { CohereClient } = require('cohere-ai');
const fs = require('fs');
const path = require('path');
const { Project, ChatAnalysis } = require('../database/schemas/all-schemas');

// Initialize SDKs lazily to handle missing keys gracefully
const getGroqClient = () => new Groq({ apiKey: process.env.GROQ_API_KEY });
const getGeminiClient = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const getOpenAiClient = () => new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const getAnthropicClient = () => new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const getCohereClient = () => new CohereClient({ token: process.env.COHERE_API_KEY || 'no-key' });

// Build the base system prompt dynamically based on the Corendon Airlines instructions
const buildSystemPrompt = (projectCards, detectedCategory = null, isRestricted = false) => {
  const rulesPath = path.join(__dirname, '..', 'rules', 'corendon_rules.json');
  const promptContextPath = path.join(__dirname, '..', 'rules', 'prompt_context.json');
  
  let corendonRules = {};
  let promptContext = {};
  
  try {
    const fileData = fs.readFileSync(rulesPath, 'utf8');
    corendonRules = JSON.parse(fileData);
    if (detectedCategory && corendonRules.rules) {
      corendonRules.rules = corendonRules.rules.filter(r => 
        r.category.toLowerCase() === detectedCategory.toLowerCase() || 
        r.category.toLowerCase() === 'random (any issue)' ||
        r.category.toLowerCase() === 'other'
      );
    }
  } catch (err) {
    console.error('Could not load corendon_rules.json', err);
  }

  try {
    if (fs.existsSync(promptContextPath)) {
      const pcData = fs.readFileSync(promptContextPath, 'utf8');
      promptContext = JSON.parse(pcData);
    }
  } catch (err) {
    console.error('Could not load prompt_context.json', err);
  }

  let errorTypesContext = [];
  const errorTypesPath = path.join(__dirname, '..', 'rules', 'error_types.json');
  try {
    if (fs.existsSync(errorTypesPath)) {
      const etData = fs.readFileSync(errorTypesPath, 'utf8');
      errorTypesContext = JSON.parse(etData);
    }
  } catch (err) {
    console.error('Could not load error_types.json', err);
  }

  let errorTypesString = errorTypesContext.length > 0
    ? errorTypesContext.map(et => `- **${et.name}**: ${et.description}`).join('\n')
    : '- **AHT**: Agent took too long.\n- **MISLEADING**: False information.\n- **CRITICAL**: Severe violation.';


  let categoryContextString = '';

  if (promptContext.globalInstructions !== undefined) {
    // Legacy single context
    categoryContextString = `
### Global System Instructions:
${promptContext.globalInstructions || 'No custom global instructions provided.'}
`;
  } else {
    // New category-wise contexts
    categoryContextString = Object.entries(promptContext).map(([category, data]) => {
      if (category === '_GlobalExample') return ''; // Ignore old format if present
      if (!data.globalInstructions && !data.perfectExample) return '';
      
      if (detectedCategory && category.toLowerCase() !== detectedCategory.toLowerCase() && category.toLowerCase() !== 'other') {
        return '';
      }
      
      let contextStr = `\n#### [Category: ${category}]\n`;
      if (data.globalInstructions) {
        contextStr += `**Policy & Context**:\n${data.globalInstructions}\n`;
      }
      if (data.perfectExample) {
        contextStr += `\n**Perfect Output Example**:\n${data.perfectExample}\n`;
      }
      return contextStr;
    }).filter(str => str !== '').join('\n');
    
    if (!categoryContextString.trim()) {
      categoryContextString = 'No custom category instructions provided.';
    } else {
      categoryContextString = (detectedCategory ? `Chat has been identified as Category: ${detectedCategory}\n` : 'First, determine the actual customer intent (category) of the chat. Then, locate the corresponding category below and follow its Policy and Example STRICTLY:\n') + categoryContextString;
    }
  }

  const buildSchema = (cards) => {
    let schema = {};
    const traverse = (nodeList) => {
      if (!nodeList) return;
      nodeList.forEach(c => {
        if (!['parent', 'grid-2', 'grid-3', 'row'].includes(c.type)) {
          schema[c.id] = c.type === 'list' ? [`<extracted text for: ${c.heading}>`] : `<extracted text for: ${c.heading}>`;
        }
        if (c.children && c.children.length > 0) traverse(c.children);
      });
    };
    traverse(cards);
    return schema;
  };

  const dynamicFindingSchema = projectCards && projectCards.length > 0
    ? {
        ...buildSchema(projectCards),
        "ruleViolated": "<The specific rule from the JSON that was broken>",
        "confidence": "<number 0-100>",
        "explanation": "<Why this rule was broken based on context>",
        "evidence": ["<Exact quote from conversation>"]
      }
    : null;

  const defaultOutputSchema = `
You MUST return your response as a valid JSON object with EXACTLY this structure:
{
  "qaScore": <number 0-100>,
  "status": "<Passed | Warning | Failed>",
  "misleadingPercentage": <number 0-100>,
  "petitionId": "<Extract the PET ID from the chat, or null if missing>",
  "agentName": "<Extract the agent's name from the chat, or null if missing>",
  "errorType": "<Short categorization of the main error, e.g. 'AHT', 'Grammatical', 'Misleading', 'None', etc.>",
  "overallRecommendation": "<A 1-2 sentence summary of the agent's performance>",

  "qaFinding": "<Main QA finding result, e.g. 'No QA Error Found' or a brief description of the primary issue>",

  "criticalChatLogs": [
    { 
      "speaker": "<Customer or Agent Name>", 
      "message": "<Exact message text. Follow the 'Critical Chat Logs Extraction Rules' strictly>" 
    }
  ],

  "findings": [
    {
      "ruleName": "<Rule or check heading, e.g. 'Issue Identification', 'Incorrect PIR Guidance', 'Misleading Information'>",
      "description": "<What the agent did related to this rule>",
      "status": "<Pass | Fail>",
      "explanation": "<Why it passed or failed, especially for failures - cite the specific rule or policy>"
    }
  ],

  "expectedAgentAction": ["<Action 1 the agent should have taken>", "<Action 2>", "<Action 3>"],
  "agentAction": "<Paragraph describing what the agent actually did>",
  "missingExpectedAction": "<What was missing from the agent's response, or 'None' if fully addressed>",

  "ahtAnalysis": {
    "result": "<'No AHT Issue' or description of AHT problem>",
    "timeline": ["<HH:MM → HH:MM — X minutes>"],
    "observation": "<Summary observation about response time thresholds>"
  },

  "reason": "<Overall explanation paragraph of why the agent passed or failed QA>",

  "qaConclusion": {
    "status": "<QA Passed | QA Failed>",
    "misleading": "<Yes | No>",
    "severity": "<None | Low | Medium | High | Critical>",
    "observations": ["<Observation 1>", "<Observation 2>"],
    "decision": "<Final paragraph with the overall QA verdict>"
  }
}`;

  const dynamicOutputSchema = `
You MUST return your response as a valid JSON object with EXACTLY this structure:
{
  "qaScore": <number 0-100>,
  "status": "<Passed | Warning | Failed>",
  "misleadingPercentage": <number 0-100>,
  "petitionId": "<Extract the PET ID from the chat, or null if missing>",
  "agentName": "<Extract the agent's name from the chat, or null if missing>",
  "errorType": "<Short categorization of the main error, e.g. 'AHT', 'Grammatical', 'Misleading', etc.>",
  "overallRecommendation": "<A 1-2 sentence summary of the agent's performance>",
  "findings": [
${JSON.stringify(dynamicFindingSchema, null, 4)}
  ]
}`;

  let rulesString = JSON.stringify(corendonRules);
  if (isRestricted && rulesString.length > 15000) {
    rulesString = rulesString.substring(0, 15000) + '...[RULES TRUNCATED DUE TO API LIMITS]"}';
  }

  return `
# Chat Analysis System Prompt (Advanced Reasoning Engine)

## Role
You are an enterprise chat quality analysis engine specialized in reviewing customer support conversations for Corendon Airlines.
Your primary objective is to evaluate conversations through evidence-based, context-aware, and production-grade analytical reasoning. You will detect misleading information, policy violations, incorrect guidance, and escalation failures by strictly comparing the full conversation against the provided JSON knowledge base.

---
## Primary Rule
The uploaded JSON files are the absolute source of truth.
Never ignore, override, or invent rules that conflict with the JSON knowledge base.
If multiple JSON files are provided, combine all of them before evaluating the conversation.

---
## Advanced Analysis Workflow
Always perform the following reasoning steps in order:

### Step 1: Holistic Conversation & Event Sequence Review
* Analyze the conversation as a continuous sequence of events rather than isolated responses.
* Track the customer's stated goal, repeated requests, previously attempted troubleshooting, and unresolved blockers throughout the chat.

### Step 2: Intent & Resolution Identification
* Identify the customer's **primary intent** (e.g., Refund, Reschedule, Baggage).
* Identify any **secondary intent** or unstated needs implied by the context.
* Determine the **expected resolution** based on the airline's standard operating procedures (SOP).

### Step 3: SOP-Aware Operational Reasoning
* Apply airline operational logic to distinguish between disruptions: specifically differentiate between cancellations, delays, diversions, returns to departure airport, missed connections, and other post-departure disruptions. 
* Contextualize the agent's actions based on the specific operational scenario. Verify that escalation recommendations are explicitly supported by SOP.

### Step 4: Rule Comparison & False Positive Reduction
* Load every matching rule from the uploaded JSON knowledge base. Avoid reusing issue categories from unrelated workflows (e.g., using baggage/PIR terminology in flight rescheduling cases).
* Before marking an expected action as failed, verify whether that action was *actually required* in the specific context of this conversation. Reduce false positives by understanding exceptions (e.g., hidden CRM info).

### Step 5: Evidence-Based Findings, Root-Cause & Impact Analysis
* For every rule, determine whether it PASSES or FAILS. 
* **Explicit Evidence Requirement:** You must extract and cite explicit supporting evidence from the chat logs before marking any finding as Pass or Fail. 
* Generate findings that describe the agent's *specific behaviour* rather than generic policy failures. Produce concise, customer-centric reasoning that explains why the behaviour created confusion or delayed resolution.
* **Repetitive Guidance:** When a customer explicitly says a suggested solution has already failed, treat repeated guidance as a potential delayed resolution or repetitive incorrect guidance, rather than simply incomplete information.

### Step 6: Claim Verification
* When agents claim actions (e.g., updating a booking, creating notes, handling claims), verify whether the conversation textually confirms those actions or their authority to do so. 
* If verification is missing, classify the issue as an "unverified promise" or "unsupported expectation" rather than a "confirmed false statement".

### Step 7: Internal Validation & Logical Consistency
* Perform a final consistency check. Verify that your findings, the assigned severity, the cited evidence, the root cause, and the final QA decision all logically align.
* Ensure contradiction detection: the agent should not give conflicting information across the chat.

---
## Confidence & Evidence Scoring
* Every finding must include an internal confidence score (0-100).
* The confidence score must be based solely on explicitly stated, confirmed evidence found in the conversation. Never invent evidence.

---
## Critical Considerations
* **Context over Keywords:** Do not trigger a failure just because a keyword matches. Understand the context.
* **Missing vs Hidden Info:** Give the agent the benefit of the doubt if their response implies they checked a system, unless the JSON explicitly requires them to ask for that information.
* **Escalations:** Verify if escalation was mandatory. If the agent escalated when they should have resolved it themselves, mark it as "Escalation Delay" or "Failed".
* **AHT (Average Handling Time):** If there is a delay of 4 or more minutes between the customer's message and the agent's response without the agent warning the customer, flag this as an AHT delay issue.

---
## Special Cases
* If the conversation has no errors, you must still return the JSON format, but with "status": "Passed", "qaScore": 100, and an empty "findings" array [].

---
## Output Requirements
Return ONLY structured JSON matching the provided schema. Do not return Markdown. Do not include any text, reasoning blocks, or explanations outside the JSON response.

---
## Critical Chat Logs Extraction Rules
When populating the "criticalChatLogs" array in the JSON output, follow these strict rules to keep evidence concise and readable:
1. Include ONLY the messages directly related to the identified QA issue.
2. Do not include greetings, acknowledgements, or unrelated conversation.
3. Include only the evidence that proves: Customer intent, Agent response, Customer reaction (if relevant).
4. Prefer 2–5 message exchanges for most cases.
5. If the issue is based on repeated behaviour, include only: First occurrence, Final occurrence, and Customer objection.
6. Remove duplicate messages that do not add new evidence.
7. Every chat log included should answer: "Does this message help prove the QA finding?" If NO, exclude it.
8. Keep the conversation chronological.
9. Do not truncate important context, but avoid unnecessary history.
10. The goal is to make the evidence concise, readable, and sufficient for QA review.

Example of GOOD extraction:
Customer: "I've already tried Manage My Booking. It isn't working."
Agent: "Please use Manage My Booking to reschedule."
Customer: "Can you reschedule it for me?"
Agent: "I don't have the required access. Please contact call support."

## AI Prompt Studio (Dynamic Context)
The following are critical instructions and examples provided by the admin. These instructions take precedence over general analysis rules.

${categoryContextString}

---
## Error Types (Severity Definitions)
Use the following definitions to classify the severity of any found errors. Assign the corresponding Error Type name exactly as shown:
${errorTypesString}

---
## Analysis Rules JSON
${rulesString}

${dynamicFindingSchema ? dynamicOutputSchema : defaultOutputSchema}
`;
};

const detectChatCategory = (conversationText) => {
  // Dynamically build the valid categories from admin-configured data
  const rulesPath = path.join(__dirname, '..', 'rules', 'corendon_rules.json');
  const promptContextPath = path.join(__dirname, '..', 'rules', 'prompt_context.json');

  const categorySet = new Set();
  try {
    const rulesData = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    if (rulesData.rules) {
      rulesData.rules.forEach(r => categorySet.add(r.category));
    }
  } catch (err) { /* ignore */ }

  try {
    if (fs.existsSync(promptContextPath)) {
      const pcData = JSON.parse(fs.readFileSync(promptContextPath, 'utf8'));
      Object.keys(pcData).forEach(k => categorySet.add(k));
    }
  } catch (err) { /* ignore */ }

  // Remove generic entries
  const ignoreList = ['Random (Any Issue)', 'Misleading', 'Wrong Issue Identification', 'Unsupported Assumption', 'Unverified Claim', 'Contradiction', 'False Promise', 'Policy Violation', 'Escalation Failure', 'Incorrect Troubleshooting', 'Failure to Answer', 'Other', '_GlobalExample'];
  ignoreList.forEach(item => categorySet.delete(item));

  const validCategories = [...categorySet];
  console.log(`Dynamic categories for local detection: ${validCategories.join(', ')}`);

  // Local Keyword-based detection (Zero AI Tokens)
  const text = conversationText.toLowerCase();
  
  // Base keywords mapping (fallback to category name if not mapped)
  const keywordMap = {
    'booking': ['booking', 'book', 'pay', 'payment', 'ticket', 'name change', 'deducted', 'transaction'],
    'cancellation': ['cancel', 'cancellation', 'refund', 'money back'],
    'reschedule': ['reschedule', 'change flight', 'new date', 'change fee', 'change my flight'],
    'baggage': ['baggage', 'luggage', 'pir', 'lost', 'bag', 'belt', 'carousel', 'item left'],
    'check-in': ['check-in', 'check in', 'boarding pass', 'online check', 'boarding'],
    'meal / seat': ['meal', 'food', 'seat', 'allergy', 'wifi', 'wi-fi', 'legroom', 'drink']
  };

  let bestCategory = 'Other';
  let maxScore = 0;

  for (const cat of validCategories) {
    const catLower = cat.toLowerCase();
    // Use predefined keywords if available, otherwise just use the category name itself
    const keywordsToCheck = keywordMap[catLower] || [catLower];
    
    let score = 0;
    for (const word of keywordsToCheck) {
      // Escape word for regex
      const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp('\\b' + safeWord + '\\b', 'g');
      const matches = text.match(regex);
      if (matches) {
        score += matches.length;
      }
    }

    if (score > maxScore) {
      maxScore = score;
      bestCategory = cat;
    }
  }

  console.log(`Locally Detected Category: ${bestCategory} (Score: ${maxScore})`);
  return bestCategory;
};

exports.analyzeChat = async (req, res) => {
  try {
    const { conversationText, aiProvider, aiModel, projectId } = req.body;

    if (!conversationText) {
      return res.status(400).json({ error: 'Conversation text is required' });
    }

    let projectCards = [];
    if (projectId && projectId !== 'default') {
      try {
        const project = await Project.findById(projectId);
        if (project && project.cards) {
          projectCards = project.cards;
        }
      } catch (err) {
        console.error('Error fetching project:', err);
      }
    }

    const providerName = aiProvider?.toUpperCase() || 'GROQ';
    let rawResponse = '';
    
    // Prevent 413 Token Limit Errors (e.g. GitHub Models 8k limit for gpt-4o)
    let safeConversationText = conversationText;
    const isRestrictedProvider = providerName.includes('GITHUB');
    
    // For 8000 token limit (~32000 chars total):
    // Allocate ~4000 chars for conversation, rest for system prompt.
    const MAX_CONV_CHARS = isRestrictedProvider ? 4000 : 45000; 
    
    if (safeConversationText.length > MAX_CONV_CHARS) {
      console.log(`Truncating conversation from ${safeConversationText.length} to ${MAX_CONV_CHARS} characters to respect token limits.`);
      const half = Math.floor(MAX_CONV_CHARS / 2);
      safeConversationText = safeConversationText.substring(0, half) + "\n\n...[CHAT TRUNCATED DUE TO API TOKEN LIMITS]...\n\n" + safeConversationText.substring(safeConversationText.length - half);
    }

    console.log(`Detecting chat category locally...`);
    const detectedCategory = detectChatCategory(safeConversationText);
    console.log(`Detected Category: ${detectedCategory}`);
    
    const activeSystemPrompt = buildSystemPrompt(projectCards, detectedCategory, isRestrictedProvider);

    console.log(`Analyzing chat using ${providerName} (${aiModel})...`);

    if (providerName.includes('GROQ')) {
      const groq = getGroqClient();
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { 
            role: 'user', 
            content: `Analyze this conversation:\n\n${safeConversationText}\n\n**CRITICAL INSTRUCTION**: Perform a thorough step-by-step QA analysis of the conversation above. Strictly adhere to all rules in the JSON knowledge base. You must evaluate every applicable rule and provide detailed explanations. Output your final response ONLY as a valid JSON object matching the requested schema exactly.` 
          }
        ],
        model: aiModel || 'llama-3.3-70b-versatile',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    } 
    else if (providerName.includes('GEMINI') || providerName.includes('GOOGLE')) {
      const genAI = getGeminiClient();
      const model = genAI.getGenerativeModel({ 
        model: aiModel || 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });
      const result = await model.generateContent(`${activeSystemPrompt}\n\nAnalyze this conversation:\n${safeConversationText}`);
      rawResponse = result.response.text();
    }
    else if (providerName.includes('OPENAI')) {
      const openai = getOpenAiClient();
      const completion = await openai.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'gpt-4o',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('ANTHROPIC')) {
      const anthropic = getAnthropicClient();
      const completion = await anthropic.messages.create({
        model: aiModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        temperature: 0.1,
        system: activeSystemPrompt,
        messages: [{ role: 'user', content: safeConversationText }]
      });
      rawResponse = completion.content[0].text;
    }
    else if (providerName.includes('DEEPSEEK')) {
      const deepseek = new OpenAI({ 
        apiKey: process.env.DEEPSEEK_API_KEY || 'no-key',
        baseURL: 'https://api.deepseek.com/v1' 
      });
      const completion = await deepseek.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'deepseek-chat',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('OLLAMA')) {
      const ollama = new OpenAI({
        apiKey: 'ollama',
        baseURL: (process.env.OLLAMA_BASE_URL || 'http://localhost:11434') + '/v1'
      });
      const completion = await ollama.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'llama3:latest',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('OPENROUTER')) {
      const openrouter = new OpenAI({
        apiKey: process.env.OPENROUTER_API_KEY || 'no-key',
        baseURL: 'https://openrouter.ai/api/v1',
        defaultHeaders: {
          "HTTP-Referer": process.env.CLIENT_URL || "http://localhost:5173",
          "X-Title": "Arena AI Server",
        }
      });
      const completion = await openrouter.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'meta-llama/llama-3.1-8b-instruct',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('HUGGING')) {
      const hf = new OpenAI({
        apiKey: process.env.HUGGINGFACE_API_KEY || 'no-key',
        baseURL: 'https://router.huggingface.co/v1'
      });
      const completion = await hf.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.1,
        max_tokens: 2000
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('CEREBRAS')) {
      const cerebras = new OpenAI({
        apiKey: process.env.CEREBRAS_API_KEY || 'no-key',
        baseURL: 'https://api.cerebras.ai/v1'
      });
      const completion = await cerebras.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'llama3.1-70b',
        temperature: 0.1,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('COHERE')) {
      const cohere = getCohereClient();
      const completion = await cohere.chat({
        message: safeConversationText,
        preamble: activeSystemPrompt,
        model: aiModel || 'command-a-plus-05-2026',
        temperature: 0.1,
      });
      rawResponse = completion.text;
    }
    else if (providerName.includes('GITHUB')) {
      const github = new OpenAI({
        apiKey: process.env.GITHUB_API_KEY || 'no-key',
        baseURL: 'https://models.inference.ai.azure.com'
      });
      const completion = await github.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: safeConversationText }
        ],
        model: aiModel || 'gpt-4o',
        temperature: 0.1,
        max_tokens: 2048,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else {
      return res.status(400).json({ error: 'Unsupported AI Provider: ' + providerName });
    }

    // Attempt to parse JSON (some models might still include markdown despite instructions)
    let cleanedResponse = rawResponse.trim();
    
    // Remove DeepSeek-R1 reasoning tags (even if truncated)
    cleanedResponse = cleanedResponse.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();

    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    }
    
    // Fallback: extract substring if there is trailing/leading non-JSON text
    const firstBrace = cleanedResponse.indexOf('{');
    const lastBrace = cleanedResponse.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
      cleanedResponse = cleanedResponse.substring(firstBrace, lastBrace + 1);
    }

    const parsedJson = JSON.parse(cleanedResponse);
    
    if (!parsedJson.findings) parsedJson.findings = [];
    if (projectCards && projectCards.length > 0) {
      parsedJson.schemaDefinition = projectCards;
    }

    return res.status(200).json(parsedJson);

  } catch (error) {
    console.error('AI Analysis Error:', error);
    return res.status(500).json({ 
      error: 'Failed to analyze conversation', 
      details: error.message 
    });
  }
};
