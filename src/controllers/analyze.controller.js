const { Groq } = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const OpenAI = require('openai');
const Anthropic = require('@anthropic-ai/sdk');
const { CohereClient } = require('cohere-ai');
const fs = require('fs');
const path = require('path');
const { Project, ChatAnalysis } = require('../database/schemas/all-schemas');

// Initialize SDKs lazily to handle missing keys gracefully
const getGroqClient = (customKey) => new Groq({ apiKey: customKey || process.env.GROQ_API_KEY });
const getGeminiClient = (customKey) => new GoogleGenerativeAI(customKey || process.env.GEMINI_API_KEY);
const getOpenAiClient = (customKey) => new OpenAI({ apiKey: customKey || process.env.OPENAI_API_KEY });
const getAnthropicClient = (customKey) => new Anthropic({ apiKey: customKey || process.env.ANTHROPIC_API_KEY });
const getCohereClient = (customKey) => new CohereClient({ token: customKey || process.env.COHERE_API_KEY || 'no-key' });

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

**STRICT COMPLIANCE MANDATE:** Do not generate a final report without first performing an exhaustive analysis. You MUST measure and compare the agent's behavior strictly against EVERY applicable rule and policy. If you have not fully analyzed the conversation against the JSON rules, do NOT output a report.

---
## Advanced Analysis Workflow (Antigravity QA Engine)
Always perform the following reasoning steps in order:

### 1. Finding Generation
Prioritize the **single highest-impact QA issue** instead of combining multiple broad observations unless each independently affects the outcome.
The primary finding should represent the biggest issue affecting the customer.
The finding should be:
* Specific
* Evidence-based
* Customer-focused
* SOP-aware

Generate conversation-specific findings instead of generic failures such as 'agent failed to assist'. Instead generate findings such as 'Agent repeatedly instructed the customer to use Manage My Booking after the customer confirmed it had already failed.'
Clearly distinguish between verified facts and assumptions. Do not present unconfirmed internal processes or outcomes as definite.

### 2. Finding Validation (Critical)
Before generating any FAIL finding, perform a mandatory validation:
1. Determine the customer's actual issue.
2. Identify the applicable SOP.
3. Verify whether the agent's actions satisfy that SOP.
4. Generate a FAIL only when there is clear evidence that the agent deviated from the SOP or provided incorrect, misleading, or incomplete guidance.

Do not assume that additional questions or more information gathering are always required. Never generate findings based on assumptions. Every finding must be supported by direct chat evidence and applicable SOP.

### 3. Prevent False Positives & Distinguish Issues
Never classify a correct action as a failure.
If the agent successfully verifies TV size after the customer asks whether the TV is acceptable, DO NOT generate 'TV verification failed.' Recognize that the verification was correctly performed.

Distinguish between:
- Required verification
- Optional verification
- Unnecessary verification
Never create findings such as "failed to collect booking reference" unless the SOP explicitly requires it for that scenario.

Distinguish between: inability to help, unsupported assumptions, misleading information, incorrect escalation, and unsupported promises. Do not treat them as the same issue.

For PASS cases:
- Explain what the agent did correctly.
- Explain why the guidance was appropriate.
- Confirm that no misleading or unsupported information was provided.

If the conversation complies with SOP, generate "No QA Issue" instead of attempting to identify minor or unsupported failures. Prioritize accuracy over finding additional issues.

### 4. Reason & Action Generation
Generate a concise, evidence-based reason that explains WHY the QA finding is correct. The reason must be clear, natural, and avoid unnecessary repetition.

Rules:
- Keep the reason between **50-90 words**.
- Write as **one concise paragraph** in professional QA language.
- Start with the **customer's issue**, not the agent's mistake.
- Identify the applicable SOP or policy only if it is relevant.
- Briefly explain what the agent should have done.
- Explain what the agent actually did.
- Describe the customer impact in one sentence.
- End with a concise QA conclusion.

Required Flow:
Customer Issue → Agent Behaviour → Supporting Chat Evidence → Applicable SOP → Gap Analysis → Customer Impact → QA Conclusion

Also, when generating Expected Agent Actions in the JSON, generate issue-specific Expected Agent Actions instead of reusable templates.

Do NOT:
- Do NOT mention anything the agent did correctly. Focus ONLY on the failure.
- Repeat the QA Finding.
- Repeat information already present in Expected Agent Action.
- Repeat the same point using different words.
- Use generic statements such as 'The agent failed to provide helpful assistance', 'The response lacked clarity', or 'The customer was dissatisfied.'

Instead explain: Exactly why this issue is Critical, Misleading, or otherwise incorrect. Focus solely on the error, why the SOP applies to that error, why the customer could be affected, and why this resulted in a QA issue.

Style: No assumptions, no filler words, no repeated SOP explanations, no unnecessary details. Every conclusion must be directly supported by the conversation and applicable policy.

Example style: 'The customer reported a payment without receiving a booking confirmation, which required payment verification before referral. Instead of collecting the required verification details, the agent referred the customer to call support and suggested outcomes that depended on further verification. This could create incorrect expectations and resulted in incomplete handling of the case.'

### 5. Chat Log Selection
Generate only the minimum evidence required. Include only messages proving the finding (Customer intent, Agent response, Customer objection, Final response proving the issue).
Do NOT include Greetings, Waiting messages, Thank you messages, Duplicate information, or Irrelevant conversation.
Preferred size: 2-5 customer/agent exchanges. Every included message must directly support the finding.

### 6. Customer Intent Detection
Identify Primary Intent, Secondary Intent, and Final Desired Outcome. Track how customer intent changes throughout the conversation. Evaluate the complete conversation, never messages independently.

### 7. Context Tracking
Remember previous messages. If customer says 'I already tried that,' remember this. Never recommend the same action without recognizing that it already failed. Track previous troubleshooting, objections, repeated requests, escalations, and previously answered questions.

### 8. SOP Reasoning
Do not only detect SOP violations. Explain which SOP applies, why it applies, whether the agent complied, and whether customer impact exists. Never mention SOP that is unrelated to the conversation.
${['Booking', 'Cancellation', 'Reschedule', 'Refund'].includes(detectedCategory) ? '\n**CRITICAL BOOKING SOP:** Because this is a ' + detectedCategory + ' query, you MUST verify whether the agent checked if the booking was made directly or through a third party. If not verified → FAIL.' : ''}

### 9. Policy Validation
Whenever the agent explains airline policy, validate internally against official policy. Determine whether the response is Correct, Partially Correct, Incomplete, Misleading, or Incorrect.

### 10. Resolution Analysis
Classify the interaction as Resolved, Partially Resolved, or Not Resolved with a brief evidence-based explanation.
Resolution depends on the customer's actual outcome, not merely whether information was provided.
A case is 'Resolved' only if the customer's core issue was fully addressed. 'Partially Resolved' means the agent addressed some aspects but left gaps. 'Not Resolved' means the customer's problem remains unaddressed.
Every resolution classification must be directly supported by the conversation.

### 11. Customer Impact
Always explain how the customer was affected (e.g., Extra effort, Delay, Confusion, False expectations, Financial risk, Operational misunderstanding). Avoid generic statements.

### 12. Root Cause Analysis
Identify WHY the issue happened (e.g., Unnecessary information gathering, Incorrect assumption, Missing SOP knowledge, Repeated guidance, Operational misunderstanding, Missing escalation, Poor clarification, Unsupported promise). Do not repeat the finding.

### 13. Consistency Validation
Before generating the report, perform an internal validation to ensure:
✓ every finding matches the evidence
✓ every conclusion matches the SOP
✓ no generic wording is used
✓ no unrelated information is introduced

Generate only internally consistent reports. Avoid introducing unsupported details or assumptions. Every statement must be directly supported by the conversation.

### 14. Hallucination Prevention
Never invent SOP, escalation paths, customer actions, agent capabilities, or airline policy. If information is missing, state 'Not established in the conversation.' Do not guess.

### 15. Confidence Validation
Calculate confidence internally. If confidence is low, prefer 'Potentially Misleading' instead of 'Incorrect.' Do not make absolute conclusions without evidence.

### 16. Final Goal
Think like an experienced QA auditor. Understand customer intent, follow chronology, detect SOP violations, validate policy, avoid false positives and hallucinations, select concise logs, explain impact, generate evidence-based findings, and produce GPT-level reasoning while keeping the JSON format EXACTLY the same.

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
  
  // 1. Remove exact Date & Time line entirely
  cleaned = cleaned.replace(/^\d{1,2}\s+[A-Za-z]{3},\s+\d{2}:\d{2}\s+[ap]m\s+IST\r?\n?/gm, '');
  
  // 1b. Remove [hh:mm am/pm] timestamps if they are already compressed in the UI
  cleaned = cleaned.replace(/^\[\d{2}:\d{2}\s+[ap]m\]\s*/gm, '');
  
  // 2. Remove "about X hours/minutes ago"
  cleaned = cleaned.replace(/^(about\s+)?\d+\s+(minute|hour)s?\s+ago\r?\n?/gm, '');
  
  // 3. Remove stray single-letter initials on their own line
  cleaned = cleaned.replace(/^[A-Z]\r?\n/gm, '');
  
  // 4. Remove UI status events & noise
  cleaned = cleaned.replace(/^.*has accepted this query.*\s*/gm, '');
  cleaned = cleaned.replace(/^Your query has been escalated.*\s*/gm, '');
  cleaned = cleaned.replace(/^Transfer from.*accepted by.*\s*/gm, '');
  cleaned = cleaned.replace(/^Reason:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Concern:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Steps Performed:.*\s*/gm, '');
  cleaned = cleaned.replace(/^Reason for Escalation:.*\s*/gm, '');
  
  // 5. Remove standard boilerplate greetings & closings to save tokens
  cleaned = cleaned.replace(/thank you for contacting.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/welcome to.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/my name is [A-Za-z\s]+.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/is there anything else.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/have a great (day|evening|night|weekend).*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/(please wait while i|please hold on while i|allow me a moment|give me a moment).*?(\.|\!|\?)\s?/gi, '');

  // 6. Remove multiple empty lines
  cleaned = cleaned.replace(/\n{2,}/g, '\n');
  
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

    const usePersonalKeys = req.headers['x-use-personal-keys'] === 'true';
    let customKey = undefined;
    
    if (usePersonalKeys) {
      if (providerName.includes('GROQ')) customKey = req.headers['x-groq-key'];
      else if (providerName.includes('GEMINI') || providerName.includes('GOOGLE')) customKey = req.headers['x-gemini-key'];
      else if (providerName.includes('OPENAI')) customKey = req.headers['x-openai-key'];
      else if (providerName.includes('ANTHROPIC')) customKey = req.headers['x-anthropic-key'];
      else if (providerName.includes('COHERE')) customKey = req.headers['x-cohere-key'];
      else if (providerName.includes('DEEPSEEK')) customKey = req.headers['x-deepseek-key'];
      else if (providerName.includes('OPENROUTER')) customKey = req.headers['x-openrouter-key'];
      else if (providerName.includes('HUGGING')) customKey = req.headers['x-huggingface-key'];
      else if (providerName.includes('CEREBRAS')) customKey = req.headers['x-cerebras-key'];
      else if (providerName.includes('GITHUB')) customKey = req.headers['x-github-key'];
    }

    if (providerName.includes('GROQ')) {
      const groq = getGroqClient(customKey);
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
      const genAI = getGeminiClient(customKey);
      const model = genAI.getGenerativeModel({ 
        model: aiModel || 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json' }
      });
      const result = await model.generateContent(`${activeSystemPrompt}\n\n${analysisUserMessage}`);
      rawResponse = result.response.text();
    }
    else if (providerName.includes('OPENAI')) {
      const openai = getOpenAiClient(customKey);
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
      const anthropic = getAnthropicClient(customKey);
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
        apiKey: customKey || process.env.DEEPSEEK_API_KEY || 'no-key',
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
        apiKey: customKey || process.env.OPENROUTER_API_KEY || 'no-key',
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
        max_tokens: restrictionLevel >= 1 ? 1500 : 3000,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('HUGGING')) {
      const hf = new OpenAI({
        apiKey: customKey || process.env.HUGGINGFACE_API_KEY || 'no-key',
        baseURL: 'https://router.huggingface.co/v1'
      });
      const completion = await hf.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'meta-llama/Llama-3.3-70B-Instruct',
        temperature: 0.1,
        max_tokens: 3000
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('CEREBRAS')) {
      const cerebras = new OpenAI({
        apiKey: customKey || process.env.CEREBRAS_API_KEY || 'no-key',
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
        max_tokens: 4000,
        response_format: { type: 'json_object' }
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('COHERE')) {
      const cohere = getCohereClient(customKey);
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
        apiKey: customKey || process.env.GITHUB_API_KEY || 'no-key',
        baseURL: 'https://models.inference.ai.azure.com'
      });
      const completion = await github.chat.completions.create({
        messages: [
          { role: 'system', content: activeSystemPrompt },
          { role: 'user', content: analysisUserMessage }
        ],
        model: aiModel || 'gpt-4o',
        temperature: 0,
        max_tokens: restrictionLevel >= 1 ? 1500 : 3000,
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
