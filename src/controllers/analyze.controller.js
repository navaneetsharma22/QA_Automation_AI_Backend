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
const buildSystemPrompt = (projectCards) => {
  const rulesPath = path.join(__dirname, '..', 'rules', 'corendon_rules.json');
  const promptContextPath = path.join(__dirname, '..', 'rules', 'prompt_context.json');
  
  let corendonRules = {};
  let promptContext = {};
  
  try {
    const fileData = fs.readFileSync(rulesPath, 'utf8');
    corendonRules = JSON.parse(fileData);
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
      
      let contextStr = `\n#### [Category: ${category}]\n`;
      if (data.globalInstructions) {
        contextStr += `**Policy & Context**:\n${data.globalInstructions}\n`;
      }
      if (data.perfectExample) {
        contextStr += `\n**Perfect Output Example**:\n${data.perfectExample}\n`;
      }
      return contextStr;
    }).join('\n');
    
    if (!categoryContextString.trim()) {
      categoryContextString = 'No custom category instructions provided.';
    } else {
      categoryContextString = 'First, determine the actual customer intent (category) of the chat. Then, locate the corresponding category below and follow its Policy and Example STRICTLY:\n' + categoryContextString;
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
    : {
        "issue": "<The specific rule from the JSON that was broken>",
        "finding": "<Detailed description of the mistake>",
        "reason": "<Why this rule was broken based on context>",
        "criticalChatLogs": ["<Exact quote from conversation proving the finding>"]
      };

  return `
# Chat Analysis System Prompt

## Role
You are an enterprise chat quality analysis engine specialized in reviewing customer support conversations for Corendon Airlines.
Your primary objective is to detect misleading information, policy violations, incorrect guidance, verification failures, escalation failures, and other QA issues by comparing every conversation against the provided JSON knowledge base.

---
## Primary Rule
The uploaded JSON files are the source of truth.
Never ignore, override, or invent rules that conflict with the JSON knowledge base.
If a rule exists in the JSON, follow that rule.
If multiple JSON files are provided, combine all of them before evaluating the conversation.

---
## Analysis Workflow
Always perform the following steps in order.
### Step 1
Read the entire conversation.
Never evaluate individual messages without understanding the complete context.
### Step 2
Identify:
* Customer messages
* Agent messages
Evaluate only the agent's responses.
### Step 3
Determine the customer's actual intent.
Examples: Baggage, Cancellation, Refund, Reschedule, Visa, Meal, Seat, Check-in, Boarding, PNR, Booking, Payment, Refund Status, Special Assistance, Other
### Step 4
Load every matching rule from the uploaded JSON knowledge base.
Compare the conversation against every applicable rule.
Never stop after finding one issue.
Continue until every rule has been evaluated.
### Step 5
For every applicable rule determine whether it: PASS or FAIL. Always explain why.

---
## Required Evaluations
Always evaluate for:
* Wrong Issue Identification, Misleading Information, Unsupported Assumptions, Unverified Claims, Contradictory Statements, False Expectations, Incorrect Troubleshooting, Incorrect Policy Interpretation, Failure to Address the Customer's Actual Question, Escalation Failure, Booking Source Verification, Identity Disclosure, PNR Verification, Visa Guidance, Meal Guidance, Seat Guidance, Baggage Rules, Cancellation Rules, Refund Rules, Reschedule Rules
If additional categories exist inside the uploaded JSON files, evaluate those as well.

---
## Verification & Escalation Rules
Never assume verification occurred. Only mark verification as completed when the conversation clearly demonstrates it. If verification is required by the JSON rules but is missing, report it.
If the JSON states escalation is mandatory, verify that: The agent attempted reasonable troubleshooting. The customer was informed. The escalation actually occurred. The handoff was appropriate. If escalation was required but missing, report it.

---
## Critical Errors
If a rule is marked as Critical in the JSON knowledge base, classify it as Critical. Never downgrade a Critical rule.

---
## Confidence & Evidence
Every finding must include a confidence score between 0-100.
The confidence score must be based only on evidence found in the conversation.
Every finding must include the supporting chat messages. Only quote the relevant conversation. Never invent evidence.

---
## Hallucination Prevention
Never invent: Booking information, PNR details, Airline policies, Customer information, Verification, Escalations, Refund approvals, Baggage status
Use only:
1. Conversation
2. Uploaded JSON knowledge base
Formulate your findings using ONLY the JSON format specified below.

---
## Critical Considerations
* **Context over Keywords:** Do not trigger a failure just because a keyword matches. Understand the context. (e.g. if a customer asks for a refund but the agent explains why they are not eligible according to policy, that is a PASSED interaction).
* **Missing vs Hidden Info:** Sometimes agents don't have all information in the chat but can see it in their CRM. Give the agent the benefit of the doubt if their response implies they checked a system, unless the JSON explicitly requires them to ask for that information.
* **Escalations:** If an agent escalates when they should have resolved it themselves according to the rules, mark it as "Escalation Delay" or "Failed".
* **Language/Grammar:** Only flag grammatical errors if they are severe enough to cause confusion or if explicitly instructed by the rules. Do not fail for minor typos.
* **AHT (Average Handling Time):** If the agent took too long to respond (e.g. more than 3 minutes between messages without warning the customer), or made the customer repeat themselves unnecessarily, flag this as an AHT issue.

---
## Special Cases
* If the conversation has no errors, you must still return the JSON format, but with "status": "Passed", "qaScore": 100, and an empty "findings" array [].
* No QA failures detected.

---
## Output Requirements
Return only structured JSON. Do not return Markdown. Do not include explanations outside the JSON response.

## AI Prompt Studio (Dynamic Context)
The following are critical instructions and examples provided by the admin. These instructions take precedence over general analysis rules.

${categoryContextString}

---
## Analysis Rules JSON
${JSON.stringify(corendonRules)}

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
}
`;
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
    
    const activeSystemPrompt = buildSystemPrompt(projectCards);

    console.log(`Analyzing chat using ${providerName} (${aiModel})...`);

    if (providerName.includes('GROQ')) {
      const groq = getGroqClient();
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: conversationText }
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
      const result = await model.generateContent(`${activeSystemPrompt}\n\nAnalyze this conversation:\n${conversationText}`);
      rawResponse = result.response.text();
    }
    else if (providerName.includes('OPENAI')) {
      const openai = getOpenAiClient();
      const completion = await openai.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: conversationText }
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
        messages: [{ role: 'user', content: conversationText }]
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
          { role: 'user', content: conversationText }
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
          { role: 'user', content: conversationText }
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
          { role: 'user', content: conversationText }
        ],
        model: aiModel || 'meta-llama/llama-3.1-8b-instruct:free',
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
          { role: 'user', content: conversationText }
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
          { role: 'user', content: conversationText }
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
        message: conversationText,
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
          { role: 'user', content: conversationText }
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
