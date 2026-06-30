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
const buildSystemPrompt = (projectCards, detectedCategory = null, restrictionLevel = 0) => {
  const rulesPath = path.join(__dirname, '..', 'rules', 'corendon_rules.json');
  const promptContextPath = path.join(__dirname, '..', 'rules', 'prompt_context.json');
  
  let corendonRules = {};
  let promptContext = {};
  
  try {
    const fileData = fs.readFileSync(rulesPath, 'utf8');
    corendonRules = JSON.parse(fileData);
    
    // Explicit Category Filtering (Manual User Selection)
    if (detectedCategory && detectedCategory !== 'Auto-Detect' && detectedCategory !== 'Other' && detectedCategory !== 'Random (Any Issue)') {
      const globalCategories = ['Booking', 'Cancellation', 'Reschedule', 'Refund'];
      
      corendonRules.rules = corendonRules.rules.filter(r => {
        // Keep rule if it explicitly matches the chosen category
        if (r.category === detectedCategory) return true;
        
        // Ensure "Booking Source Verification" (stored in Cancellation rule block) 
        // is injected for the 4 specific global categories as requested by user.
        if (r.id === 'cancellation' && globalCategories.includes(detectedCategory)) return true;
        
        return false;
      });
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
      
      // Explicit Category Filtering for Context
      if (detectedCategory && detectedCategory !== 'Auto-Detect' && detectedCategory !== 'Other' && detectedCategory !== 'Random (Any Issue)') {
        if (category !== detectedCategory) return ''; // Only inject context for selected category
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
    
    if (restrictionLevel === 1 && categoryContextString.length > 4000) {
      categoryContextString = categoryContextString.substring(0, 4000) + '\n...[CONTEXT TRUNCATED DUE TO API LIMITS]';
    } else if (restrictionLevel === 2 && categoryContextString.length > 500) {
      categoryContextString = categoryContextString.substring(0, 500) + '\n...[CONTEXT TRUNCATED DUE TO EXTREME API LIMITS]';
    }
    
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
      "speaker": "<MUST use the ACTUAL REAL NAME of the person speaking, e.g., 'Dennis (Agent)' or 'Makayla Mendoza (Customer)'. DO NOT use dummy names like 'Agent' or 'Customer'.>", 
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
  if (restrictionLevel === 1 && rulesString.length > 8000) {
    rulesString = rulesString.substring(0, 8000) + '...[RULES TRUNCATED DUE TO API LIMITS]"}';
  } else if (restrictionLevel === 2 && rulesString.length > 1000) {
    rulesString = rulesString.substring(0, 1000) + '...[RULES TRUNCATED DUE TO EXTREME API LIMITS]"}';
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
## Critical Considerations & Mandatory Checks
* **MANDATORY RULE EVALUATION:** You MUST carefully read and evaluate EVERY SINGLE RULE in the provided JSON against the conversation. You must not skip any policy constraints (e.g., verifying booking sources before giving information).
* **MANDATORY AHT CALCULATION (CRITICAL):** You MUST mathematically calculate the time difference between the customer's message timestamp and the agent's response timestamp. If the difference is 4 minutes or greater, and the agent did not provide a prior hold warning, you MUST flag it as an AHT failure. Do not skip this calculation. Only use timestamps that are explicitly present in the conversation — do NOT fabricate or estimate timestamps.
* **Context over Keywords:** Do not trigger a failure just because a keyword matches. Understand the context.
* **Missing vs Hidden Info:** Give the agent the benefit of the doubt if their response implies they checked a system, unless the JSON explicitly requires them to ask for that information.
* **Escalations:** Verify if escalation was mandatory. If the agent escalated when they should have resolved it themselves, mark it as "Escalation Delay" or "Failed".

---
## Mandatory Fail Checklist (MUST evaluate every item)
Before finalizing your verdict, you MUST check each of the following. If ANY item is true, the conversation CANNOT be marked as "Passed":
1. **Missing Booking Reference:** Did the agent collect the booking reference (PNR) before providing policy guidance? If NO → FAIL.
2. **Repeated Questions:** Did the agent ask a question that the customer already answered? If YES → FAIL (finding).
3. **Missing Passenger Name Verification:** Did the agent verify the passenger's full name? If not collected → note as finding.
4. **Booking Source Verification:** For cancellation/refund/reschedule/booking queries, did the agent verify whether the booking was made directly or through a third party? If NO → FAIL.
5. **Misleading Guidance:** Did the agent provide advice that could confuse the customer or contradict the actual policy? If YES → FAIL.
6. **Unverified Commitments:** Did the agent promise something they cannot confirm (e.g., refund timeline, seat availability)? If YES → FAIL.
7. **AHT Delay:** Was there a gap of 4+ minutes between customer message and agent response without warning? If YES → FAIL.

Only after confirming ALL 7 items are clear can you assign "Passed".

---
## Consistency & Determinism Rules
* Your analysis must be DETERMINISTIC. Given the same conversation and the same rules, you must always produce the same verdict.
* Do NOT allow superficial formatting differences (e.g., speaker labels, timestamps, whitespace) to change your analytical conclusions.
* Evaluate the SUBSTANCE of what was said, not how names are formatted.
* Do NOT fabricate or hallucinate timestamps, durations, or evidence that does not exist in the conversation.

---
## LOGICAL CONSISTENCY ENFORCEMENT (CRITICAL — DO NOT VIOLATE)
Your findings and your final verdict MUST be logically aligned. Apply these rules strictly:

1. **If ANY finding has status "Fail"** → the qaConclusion.status MUST be "QA Failed" and the top-level status MUST be "Failed" or "Warning". It is LOGICALLY IMPOSSIBLE for the status to be "Passed" when any finding is "Fail".
2. **If a finding says "could have" or "should have"** → that means the agent DID NOT do it, which means it is a FAILURE, not a Pass. Mark it as "Fail".
3. **If the agent did not collect a booking reference (PNR)** → the "Mandatory Information Gathering" finding MUST be "Fail", not "Pass". Do NOT write "Pass" and then say "but could have asked for PNR" — that is contradictory.
4. **qaFinding must reflect actual issues found.** If you found failures, do NOT write "No QA Error Found". Write a summary of the actual failures.
5. **qaScore must reflect the number and severity of failures.** A conversation with 1 Fail finding cannot score above 80. A conversation with 2+ Fail findings cannot score above 65.

---
## Special Cases
* If the conversation has no errors, you must still return the JSON format, but with "status": "Passed", "qaScore": 100, and an empty "findings" array [].

---
## Output Requirements
Return ONLY structured JSON matching the provided schema. Do not return Markdown. Do not include any text, reasoning blocks, or explanations outside the JSON response.

---
## Critical Chat Logs Extraction Rules (LIMIT: MAXIMUM 4 PAIRS / 8 MESSAGES)
When populating the "criticalChatLogs" array in the JSON output, you MUST follow these strict boundaries:
1. **LIMIT OF 4 PAIRS:** You can return up to 4 exchanges (maximum 8 messages total). Do NOT exceed this limit.
2. **HUNT FOR THE SENSITIVE ERROR:** Do not blindly copy from the beginning of the chat. You must scan the chat, find the exact moment the agent made a mistake (or provided critical info), and ONLY extract those sensitive exchanges.
3. **STRICTLY NO FULL CHAT DUMPS:** Never include the entire conversation.
4. **DO NOT INCLUDE NOISE:** Exclude greetings, closing remarks, holding messages, and unrelated pleasantries.
5. **EVIDENCE ONLY:** Include only the customer intent, the agent's failing/critical response, and the customer's reaction to it.
6. **USE REAL NAMES:** When defining the "speaker", you MUST use the actual real name of the person speaking from the chat (e.g., "Dennis (Agent)" or "Makayla Mendoza (Customer)"). DO NOT use generic dummy labels like "Agent" or "Customer" alone.
7. Every chat log included MUST answer: "Does this message directly prove the QA finding?" If NO, exclude it.

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

const cleanChatTranscript = (rawText) => {
  if (!rawText) return rawText;
  
  let cleaned = rawText;
  
  // 1. Convert Date & Time to just [Time]
  cleaned = cleaned.replace(/^\d{1,2}\s+[A-Za-z]{3},\s+(\d{2}:\d{2}\s+[ap]m)\s+IST\s*/gm, '[$1]\n');
  
  // 2. Remove "X minutes ago"
  cleaned = cleaned.replace(/^\d+\s+(minute|hour)s?\s+ago\s*/gm, '');
  
  // 3. Remove stray single-letter initials on their own line
  cleaned = cleaned.replace(/^[A-Z]\r?\n/gm, '');
  
  // 4. Remove UI status events
  cleaned = cleaned.replace(/^.*has accepted this query.*\s*/gm, '');
  cleaned = cleaned.replace(/^Your query has been escalated.*\s*/gm, '');
  cleaned = cleaned.replace(/^Transfer from.*accepted by.*\s*/gm, '');
  cleaned = cleaned.replace(/^Reason:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Concern:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Steps Performed:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Reason for Escalation:.*\s*/gm, '');
  
  // 5. Remove multiple empty lines
  cleaned = cleaned.replace(/\n{2,}/g, '\n');
  
  // 6. Compress Time + Speaker Name onto one line
  cleaned = cleaned.replace(/^(\[\d{2}:\d{2}\s+[ap]m\])\n([^\n]+)\n/gm, '\n$1 $2:\n');
  
  return cleaned.trim();
};

exports.analyzeChat = async (req, res) => {
  try {
    const { conversationText, aiProvider, aiModel, projectId } = req.body;

    if (!conversationText) {
      return res.status(400).json({ error: 'Conversation text is required' });
    }
    
    // Compress the UI noise out of the chat transcript before it reaches the AI
    const cleanedConversationText = cleanChatTranscript(conversationText);

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
    
    // Prevent 413 Token Limit Errors (e.g. GitHub Models 8k limit, DeepSeek R1 4k limit)
    let safeConversationText = cleanedConversationText;
    const isR1 = (aiModel || '').toLowerCase().includes('r1');
    const isGitHub = providerName.includes('GITHUB');
    const isGroq = providerName.includes('GROQ');
    const restrictionLevel = isR1 ? 2 : ((isGitHub || isGroq) ? 1 : 0);
    
    let MAX_CONV_CHARS = 45000;
    if (restrictionLevel === 1) MAX_CONV_CHARS = 4000;
    if (restrictionLevel === 2) MAX_CONV_CHARS = 1500;
    
    if (safeConversationText.length > MAX_CONV_CHARS) {
      console.log(`Truncating conversation from ${safeConversationText.length} to ${MAX_CONV_CHARS} characters to respect token limits.`);
      const half = Math.floor(MAX_CONV_CHARS / 2);
      safeConversationText = safeConversationText.substring(0, half) + "\n\n...[CHAT TRUNCATED DUE TO API TOKEN LIMITS]...\n\n" + safeConversationText.substring(safeConversationText.length - half);
    }

    console.log(`Detecting chat category locally...`);
    const detectedCategory = detectChatCategory(safeConversationText);
    console.log(`Detected Category: ${detectedCategory}`);
    
    const activeSystemPrompt = buildSystemPrompt(projectCards, detectedCategory, restrictionLevel);

    // Build the analysis user message once — used by ALL providers for consistency
    const analysisUserMessage = `Analyze this conversation:\n\n${safeConversationText}\n\n**CRITICAL INSTRUCTION**: Perform a thorough step-by-step QA analysis of the conversation above. Strictly adhere to all rules in the JSON knowledge base. You must evaluate every applicable rule and provide detailed explanations. Check for: missing mandatory information gathering, repeated questions, AHT delays, misleading guidance, and unverified claims.\n\n**CRITICAL LIMIT**: You MUST extract a maximum of 4 pairs (up to 8 messages total) for your criticalChatLogs array, focusing ONLY on the exact moment the sensitive error occurred. Output your final response ONLY as a valid JSON object matching the requested schema exactly.`;

    console.log(`Analyzing chat using ${providerName} (${aiModel})...`);

    if (providerName.includes('GROQ')) {
      const groq = getGroqClient();
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'llama-3.3-70b-versatile',
        temperature: 0,
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
      const result = await model.generateContent(`${activeSystemPrompt}\n\n${analysisUserMessage}`);
      rawResponse = result.response.text();
    }
    else if (providerName.includes('OPENAI')) {
      const openai = getOpenAiClient();
      const completion = await openai.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'gpt-4o',
        temperature: 0,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('ANTHROPIC')) {
      const anthropic = getAnthropicClient();
      const completion = await anthropic.messages.create({
        model: aiModel || 'claude-3-5-sonnet-20241022',
        max_tokens: 1500,
        temperature: 0,
        system: activeSystemPrompt,
        messages: [{ role: 'user', content: analysisUserMessage }]
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
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'deepseek-chat',
        temperature: 0,
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
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'llama3:latest',
        temperature: 0,
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
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'meta-llama/llama-3.1-8b-instruct',
        temperature: 0,
        max_tokens: 4000,
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
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('CEREBRAS')) {
      const cerebras = new OpenAI({
        apiKey: process.env.CEREBRAS_API_KEY || 'no-key',
        baseURL: 'https://api.cerebras.ai/v1',
        timeout: 45000
      });
      const completion = await cerebras.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'llama-3.3-70b',
        temperature: 0,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('COHERE')) {
      const cohere = getCohereClient();
      const completion = await cohere.chat({
        message: analysisUserMessage,
        preamble: activeSystemPrompt,
        model: aiModel || 'command-a-plus-05-2026',
        temperature: 0,
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
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'gpt-4o',
        temperature: 0,
        max_tokens: isR1 ? 800 : 4000,
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
