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
Your primary objective is ACCURATE evaluation — correctly identifying genuine QA issues AND correctly passing compliant conversations with EQUAL confidence. A false-positive QA failure (incorrectly failing a conversation that follows SOP) is EQUALLY as damaging as missing a real issue. You must be just as confident in generating "No QA Issue" as you are in identifying genuine problems. Evaluate conversations through evidence-based, context-aware reasoning by strictly comparing the full conversation against the provided JSON knowledge base.

---
## PRIMARY QA PRINCIPLE: VERIFICATION-FIRST
Always answer ONE question first: **"Did the agent actually verify the customer's situation before giving the answer?"**
If NO → Critical QA Failure. If YES → Continue evaluation. Never assume, never infer, never invent policy.

---
## Primary Rule
The uploaded JSON files are the absolute source of truth.
Never ignore, override, or invent rules that conflict with the JSON knowledge base.
If multiple JSON files are provided, combine all of them before evaluating the conversation.

**STRICT COMPLIANCE MANDATE:** Do not generate a final report without first performing an exhaustive analysis. You MUST measure and compare the agent's behavior strictly against EVERY applicable rule and policy.

---
## ⚠️ CRITICAL: FALSE-POSITIVE PREVENTION (HIGHEST PRIORITY RULE)
**A false-positive QA failure is EQUALLY as harmful as missing a real issue.** Your system must avoid over-detection. Apply these absolute rules:

1. **DEFAULT IS PASS.** Start every evaluation assuming the agent performed correctly. Only override to FAIL when you have UNDENIABLE, DIRECT evidence of a specific SOP violation.
2. **Do NOT invent requirements.** If the SOP does not EXPLICITLY require an action for this specific scenario, the agent is NOT required to perform it. Do not fail agents for skipping optional or best-practice actions.
3. **Do NOT over-analyze.** If the agent addressed the customer's core concern correctly and did not provide misleading information, the interaction is a PASS — even if minor improvements could theoretically be suggested.
4. **Generic failures are PROHIBITED.** Never generate vague findings such as "failed to gather complete information", "did not follow proper procedure", or "incomplete assistance" unless you can cite the EXACT SOP requirement AND the EXACT chat evidence showing the violation.
5. **Sufficient is PASS.** An agent does not need a PERFECT interaction to pass QA. If the response is SUFFICIENT to address the customer's issue without misleading them, it is a PASS.
6. **Partial information is NOT a failure** unless the SOP explicitly requires that specific information for this issue type AND the missing information directly caused or could cause customer harm.
7. **Escalation is a valid resolution.** If the agent correctly identified that the issue requires L3/backend verification and escalated appropriately, this is CORRECT behavior — not a failure.
8. **Do NOT penalize correct behavior.** If the agent followed the SOP correctly, do NOT create findings about what they "could have done better" and mark them as failures.
9. **When in doubt, PASS.** If you are uncertain whether the agent violated an SOP, the finding should be PASS. Only generate FAIL when you are certain.

---
## Advanced Analysis Workflow (Antigravity QA Engine)
Always perform the following reasoning steps in order:

### 1. Finding Generation — ACCURACY FIRST
**CRITICAL: Generate ACCURATE findings, not MAXIMUM findings.** The goal is ZERO false positives, not maximum issue detection.

Before generating ANY finding, you MUST answer these gate questions:
* "Did the agent ACTUALLY deviate from the SOP?" — If NO → do NOT generate a finding.
* "Is there DIRECT chat evidence proving this failure?" — If NO → do NOT generate a finding.
* "Does the SOP EXPLICITLY require this action for THIS specific scenario?" — If NO → do NOT generate a finding.
* "Did this actually harm or mislead the customer?" — If NO → strongly reconsider whether this is a real finding.

Prioritize the **single highest-impact QA issue** instead of combining multiple broad observations.
Generate conversation-specific findings instead of generic failures. Instead of 'agent failed to assist', generate 'Agent repeatedly instructed the customer to use Manage My Booking after the customer confirmed it had already failed.'

**PROHIBITED False-Positive Patterns (NEVER generate these unless SOP EXPLICITLY requires the action for THIS scenario):**
* "Failed to collect booking reference" — unless SOP REQUIRES PNR collection for this exact issue type AND the agent was at the stage where collection was necessary
* "Failed to verify booking source" — unless the customer's issue is specifically about cancellation/refund/reschedule of a booking AND verification was not performed
* "Incomplete information gathering" — unless you can name the SPECIFIC missing field AND cite the exact SOP requirement mandating it
* "Generic/insufficient response" — if the response is factually correct and addresses the customer's concern, it is SUFFICIENT and is a PASS
* "Did not escalate properly" — unless the agent had a clear SOP obligation to escalate AND demonstrably failed to do so
* "Did not provide enough detail" — if the agent provided correct information, additional detail is optional, not mandatory

### 2. MANDATORY PRE-FAIL VALIDATION CHECKLIST (Must complete ALL steps before ANY Fail finding)
Before generating ANY FAIL finding, you MUST complete ALL 7 validation steps below. If ANY step does not clearly support the failure, DO NOT generate the FAIL:

**Step 1 — Customer Intent:** What is the customer's ACTUAL issue? (Not what you assume it might be — based on their own words)
**Step 2 — Applicable SOP:** Which SPECIFIC SOP rule applies to this scenario? You must be able to quote the exact rule.
**Step 3 — Agent Actions:** What did the agent ACTUALLY do? (Based on direct chat evidence ONLY — no assumptions)
**Step 4 — SOP Compliance Check:** Does the agent's action SATISFY the applicable SOP? If YES → finding is PASS. If partially → evaluate whether the gap is material and harmful.
**Step 5 — Evidence Gate:** Is there DIRECT, UNAMBIGUOUS chat evidence proving the agent deviated from the SOP? If there is ANY ambiguity or room for interpretation → do NOT fail.
**Step 6 — Customer Impact:** Did the agent's action actually mislead, harm, or create incorrect expectations for the customer? If NO → strongly reconsider whether this is a genuine failure.
**Step 7 — False Positive Check:** Could a reasonable, experienced human QA auditor interpret the agent's response as acceptable and SOP-compliant? If YES → the finding MUST be PASS.

Do NOT assume that additional questions or more information gathering are always required. Do NOT generate findings based on assumptions or theoretical improvements. Every FAIL finding must pass ALL 7 validation steps above with clear evidence.

### 3. PASS Case Handling & False-Positive Prevention
**Correctly passing a compliant conversation is EQUALLY important as detecting a genuine failure.** A production QA system must be just as confident in saying "No QA Issue" as it is in identifying genuine problems.

**When the conversation complies with SOP (this should be the DEFAULT outcome):**
* Generate "No QA Error Found" as the qaFinding — do NOT force-find minor issues to justify a failure
* Explain what the agent did correctly — cite specific correct actions from the conversation
* Explain why the guidance was appropriate — reference the applicable SOP
* Confirm that no misleading or unsupported information was provided
* Set qaScore to 85-100 — do NOT penalize compliant conversations for minor stylistic preferences
* Include findings with status "Pass" explaining correct agent behavior

**Verification Type Distinctions (CRITICAL for avoiding false positives):**
- **Required verification** = SOP EXPLICITLY mandates this for the specific issue type → failure to do it = FAIL
- **Optional verification** = Good practice but NOT SOP-mandated → absence = PASS (may note as minor observation)
- **Unnecessary verification** = Not relevant to this issue → agent correctly skipped it = PASS

**Anti-False-Positive Rules:**
* Never classify a correct action as a failure — if the agent did something right, acknowledge it
* Never create "failed to collect X" findings unless the SOP EXPLICITLY requires X for THIS specific scenario
* Distinguish between: inability to help, unsupported assumptions, misleading information, incorrect escalation, and unsupported promises — these are DIFFERENT issues, do NOT conflate them
* If the conversation complies with SOP, generate "No QA Issue" with full confidence
* Prioritize ACCURACY over finding additional issues — ZERO false positives is the primary goal
* Do NOT manufacture findings to fill the findings array — if there are no genuine issues, the array should contain only PASS findings or be minimal

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

Do NOT (these rules apply to FAIL finding reasons only — for PASS findings, explain what the agent did correctly instead):
- In FAIL findings, focus on the specific failure and its impact rather than listing correct actions.
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

### 6. HUMAN DECISION FLOW (3-Step Framework)
**Step 1: Identify the customer's REAL issue.** Ignore the ticket category. Find the actual problem based on the customer's words (e.g. "I can't cancel" = Cancellation).
**Step 2: Check whether the agent correctly understood the issue.** If the agent answers a different issue = Critical Failure.
**Step 3: Determine whether verification was REQUIRED.** General FAQs usually don't require verification. Booking-specific, refunds, compensation, cancellation, reschedule, and baggage issues ALWAYS require verification before answering.

### 7. Context Tracking
Remember previous messages. If customer says 'I already tried that,' remember this. Never recommend the same action without recognizing that it already failed. Track previous troubleshooting, objections, repeated requests, escalations, and previously answered questions.

### 8. SOP Reasoning
Do not only detect SOP violations. Explain which SOP applies, why it applies, whether the agent complied, and whether customer impact exists. Never mention SOP that is unrelated to the conversation.
${['Booking', 'Cancellation', 'Reschedule', 'Refund'].includes(detectedCategory) ? '\n**BOOKING SOURCE SOP:** Because this is a ' + detectedCategory + ' query, check whether the agent verified the booking source (direct vs third-party). If the customer\'s issue REQUIRES booking source verification per SOP AND the agent did not verify it AND it led to incorrect guidance → this is a valid FAIL. However, if the booking source was already clear from context, or the agent\'s guidance was correct regardless, do NOT auto-fail for missing this step.' : ''}

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

### 17. CONTRADICTION CHECK
Mark as a Critical Failure if the agent contradicts their own limitations. Example patterns:
* "I cannot access booking" → Later says "I checked your booking"
* "I cannot verify" → Later says "I confirmed"
* "I cannot access" → Later says "I know your fare"

### 18. MISLEADING ASSISTANCE RULE
Mark MISLEADING whenever the agent states any of the following without verification:
"You are eligible", "You will receive", "You cannot", "You will get", "You are entitled", "You will definitely", "You are not eligible", "This fare cannot", "There is no exception", "This is policy", "You'll receive compensation", "You'll receive refund", "Courier will deliver", "Priority baggage failed", "Hotel will be covered", "Food vouchers", "Automatic rebooking".

### 19. SUPERVISOR VALIDATION
If the customer requests a supervisor, verify: Was escalation completed? Did the supervisor add value? Did the supervisor verify more? Or did they simply repeat the same unverified information? If repeat only = Failed escalation.

---
## LOGICAL CONSISTENCY ENFORCEMENT (CRITICAL — DO NOT VIOLATE)
Your findings and your final verdict MUST be logically aligned. Apply these rules strictly:

1. **If ANY finding has status "Fail"** → qaConclusion.status MUST be "QA Failed" and top-level status MUST be "Failed" or "Warning". It is LOGICALLY IMPOSSIBLE for status to be "Passed" when any finding is "Fail".
2. **If ALL findings have status "Pass"** → qaConclusion.status MUST be "QA Passed" and top-level status MUST be "Passed". qaScore MUST be 85 or above. It is LOGICALLY IMPOSSIBLE for status to be "Failed" when all findings are "Pass".
3. **"Could have" or "should have" does NOT automatically mean FAIL.** First evaluate whether the SOP REQUIRES the action for this scenario. If it is optional or best-practice only → finding status is "Pass" with an observation note. Only mark as "Fail" if the SOP explicitly mandates the action AND there is evidence of customer harm.
4. **Not collecting a booking reference (PNR)** is ONLY a failure if the SOP EXPLICITLY requires PNR collection for this specific issue type AND the agent was at a stage where it was needed. Do NOT auto-fail for missing PNR.
5. **qaFinding must reflect reality.** If no genuine SOP violations were found, you MUST write "No QA Error Found". Do NOT fabricate or force issues to justify a failure.
6. **qaScore must be consistent with findings.** 0 Fail findings → qaScore 85-100. 1 Fail finding → qaScore max 80. 2+ Fail findings → qaScore max 65.
7. **Do NOT contradict yourself.** If your finding explanation describes correct agent behavior, the finding status MUST be "Pass", not "Fail". Always re-read your own explanation before setting the status.
8. **NEVER force a failure.** If you cannot identify a clear, evidence-based, SOP-mandated violation with direct chat evidence, the verdict MUST be PASS. When in doubt → PASS.

---
## Special Cases
* If the conversation has no errors, return the JSON with "status": "Passed", "qaScore" between 90-100, "qaFinding": "No QA Error Found", and findings with status "Pass" explaining what the agent did correctly.
* If only minor observations exist (not SOP violations), set "status": "Passed", "qaScore" between 85-95, and include observations as informational notes — NOT as failures.
* NEVER force a "Failed" or "Warning" status when no genuine SOP violation with direct evidence exists.

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

/**
 * Compressed System Prompt for DeepSeek R1 (GitHub Models)
 * Preserves ALL policy analysis logic but fits within the ~4000 token input limit.
 * Only used when the selected model is DeepSeek-R1 via GitHub Models.
 */
const buildCompressedSystemPromptForR1 = (projectCards, detectedCategory) => {
  const rulesPath = path.join(__dirname, '..', 'rules', 'corendon_rules.json');
  const promptContextPath = path.join(__dirname, '..', 'rules', 'prompt_context.json');

  let corendonRules = {};
  let promptContext = {};

  try {
    const fileData = fs.readFileSync(rulesPath, 'utf8');
    corendonRules = JSON.parse(fileData);
    // Explicit Category Filtering (same logic as main prompt)
    if (detectedCategory && detectedCategory !== 'Auto-Detect' && detectedCategory !== 'Other' && detectedCategory !== 'Random (Any Issue)') {
      const globalCategories = ['Booking', 'Cancellation', 'Reschedule', 'Refund'];
      corendonRules.rules = corendonRules.rules.filter(r => {
        if (r.category === detectedCategory) return true;
        if (r.id === 'cancellation' && globalCategories.includes(detectedCategory)) return true;
        return false;
      });
    }
  } catch (err) { console.error('Could not load corendon_rules.json for R1 prompt', err); }

  try {
    if (fs.existsSync(promptContextPath)) {
      const pcData = fs.readFileSync(promptContextPath, 'utf8');
      promptContext = JSON.parse(pcData);
    }
  } catch (err) { console.error('Could not load prompt_context.json for R1 prompt', err); }

  // Load error types
  let errorTypesContext = [];
  const errorTypesPath = path.join(__dirname, '..', 'rules', 'error_types.json');
  try {
    if (fs.existsSync(errorTypesPath)) {
      const etData = fs.readFileSync(errorTypesPath, 'utf8');
      errorTypesContext = JSON.parse(etData);
    }
  } catch (err) { console.error('Could not load error_types.json for R1 prompt', err); }

  const errorTypesString = errorTypesContext.length > 0
    ? errorTypesContext.map(et => `${et.name}: ${et.description}`).join('; ')
    : 'AHT: Agent took too long; MISLEADING: False info; CRITICAL: Severe violation';

  // Build compact category context
  let categoryContextString = '';
  if (promptContext.globalInstructions !== undefined) {
    categoryContextString = promptContext.globalInstructions || '';
  } else {
    categoryContextString = Object.entries(promptContext).map(([category, data]) => {
      if (category === '_GlobalExample') return '';
      if (!data.globalInstructions && !data.perfectExample) return '';
      if (detectedCategory && detectedCategory !== 'Auto-Detect' && detectedCategory !== 'Other' && detectedCategory !== 'Random (Any Issue)') {
        if (category !== detectedCategory) return '';
      }
      let str = `[${category}] `;
      if (data.globalInstructions) str += data.globalInstructions;
      return str;
    }).filter(s => s).join('\n');
  }

  // Aggressive truncation for R1 token limits
  if (categoryContextString.length > 800) {
    categoryContextString = categoryContextString.substring(0, 800) + '...[TRUNCATED]';
  }

  let rulesString = JSON.stringify(corendonRules);
  if (rulesString.length > 2000) {
    rulesString = rulesString.substring(0, 2000) + '...[TRUNCATED]}';
  }

  // Build output schema (same structure, compact formatting)
  const buildSchema = (cards) => {
    let schema = {};
    const traverse = (nodeList) => {
      if (!nodeList) return;
      nodeList.forEach(c => {
        if (!['parent', 'grid-2', 'grid-3', 'row'].includes(c.type)) {
          schema[c.id] = c.type === 'list' ? [`<text>`] : `<text>`;
        }
        if (c.children && c.children.length > 0) traverse(c.children);
      });
    };
    traverse(cards);
    return schema;
  };

  const hasDynamicSchema = projectCards && projectCards.length > 0;
  const dynamicFindingSchema = hasDynamicSchema ? {
    ...buildSchema(projectCards),
    "ruleViolated": "<rule>",
    "confidence": "<0-100>",
    "explanation": "<why>",
    "evidence": ["<quote>"]
  } : null;

  const outputSchema = dynamicFindingSchema
    ? `{"qaScore":<0-100>,"status":"<Passed|Warning|Failed>","misleadingPercentage":<0-100>,"petitionId":"<PET ID or null>","agentName":"<name or null>","errorType":"<type>","overallRecommendation":"<summary>","findings":[${JSON.stringify(dynamicFindingSchema)}]}`
    : `{"qaScore":<0-100>,"status":"<Passed|Warning|Failed>","misleadingPercentage":<0-100>,"petitionId":"<PET ID or null>","agentName":"<name or null>","errorType":"<error category>","overallRecommendation":"<1-2 sentence summary>","qaFinding":"<main finding or 'No QA Error Found'>","criticalChatLogs":[{"speaker":"<REAL NAME (Role)>","message":"<exact text>"}],"findings":[{"ruleName":"<rule>","description":"<what agent did>","status":"<Pass|Fail>","explanation":"<why, cite SOP>"}],"expectedAgentAction":["<action>"],"agentAction":"<what agent actually did>","missingExpectedAction":"<what was missing or None>","ahtAnalysis":{"result":"<result>","timeline":["<HH:MM→HH:MM>"],"observation":"<obs>"},"reason":"<50-90 word explanation: Customer Issue→Agent Action→Evidence→SOP→Impact→Conclusion>","qaConclusion":{"status":"<QA Passed|QA Failed>","misleading":"<Yes|No>","severity":"<None|Low|Medium|High|Critical>","observations":["<obs>"],"decision":"<verdict>"}}`;

  const bookingSourceNote = ['Booking', 'Cancellation', 'Reschedule', 'Refund'].includes(detectedCategory)
    ? `\nBOOKING SOURCE: For ${detectedCategory} queries, check if agent verified booking source (direct vs third-party) per SOP. Only fail if SOP requires it AND agent skipped it AND it led to incorrect guidance.`
    : '';

  return `# Corendon Airlines QA Engine

## Role
You evaluate customer support chats against airline SOP rules. The JSON rules below are the ABSOLUTE source of truth. Never invent rules.

## CRITICAL: Accuracy Rules
0. VERIFICATION-FIRST: Ask "Did the agent actually verify the customer's situation before answering?" If NO → Critical Failure. If YES → Continue.
1. DEFAULT IS PASS. Only fail with: exact SOP violation + direct chat evidence + real customer harm.
2. Never invent requirements. If SOP doesn't EXPLICITLY require an action for THIS scenario → PASS.
3. No false positives. Sufficient response = PASS even if not perfect. When in doubt → PASS.
4. Escalation is valid resolution. Partial info is NOT failure unless SOP mandates it AND it caused harm.
5. Before ANY Fail, verify ALL: (a) which SOP rule applies, (b) agent actually deviated, (c) direct unambiguous evidence, (d) customer was harmed/misled, (e) would a human QA auditor also fail this? If any check fails → PASS.
6. PROHIBITED false-positive patterns: "Failed to collect PNR" (unless SOP requires for THIS issue), "Incomplete info gathering" (unless you name the specific missing field + SOP rule), "Generic/insufficient response" (if factually correct → PASS).

## Consistency (MANDATORY)
- Any FAIL finding → status="Failed"/"Warning", qaConclusion.status="QA Failed"
- ALL PASS findings → status="Passed", qaScore 85-100, qaConclusion.status="QA Passed"
- Score: 0 Fails→85-100. 1 Fail→max 80. 2+ Fails→max 65.
- Never contradict yourself. If explanation shows correct behavior → status must be Pass.
- If no genuine SOP violations → qaFinding MUST be "No QA Error Found"

## Analysis Steps
1. Find REAL issue (not ticket category) → Did agent understand it? → Was verification required?
2. Find applicable SOP rules from JSON
3. Compare agent's actual actions vs SOP requirements
4. Generate findings with DIRECT evidence only
5. Contradiction Check: E.g., "I cannot access" followed by "I checked your booking" = CRITICAL FAIL.
6. Misleading Check: Fails if agent says "You will receive", "You are eligible", "You cannot", etc. without verification.
7. Validate agent's policy statements against official policy
8. Classify resolution: Resolved/Partially Resolved/Not Resolved
9. Explain customer impact specifically (not generic)
${bookingSourceNote}

## Chat Logs: Max 4 pairs (8 msgs). Only error evidence. Use REAL speaker names from chat. No greetings/closings/noise.

${categoryContextString ? `## Policy Context\n${categoryContextString}\n` : ''}
## Error Types: ${errorTypesString}

## Rules JSON
${rulesString}

## GOLDEN RULE (Final Checklist)
1. Did the agent identify the actual issue?
2. Did the agent verify all required information before answering?
3. Did the agent provide any unverified commitments or guarantees?
4. Did the agent contradict their own limitations?
5. Would a reasonable customer leave with incorrect expectations?
If ANY answer is YES (to 3, 4, 5) or NO (to 1, 2) → QA Finding is FAIL with chat evidence.

## OUTPUT: Return ONLY valid JSON (no markdown, no reasoning text, no \`\`\`)
${outputSchema}`;
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
    if (restrictionLevel === 2) MAX_CONV_CHARS = 3500;
    
    if (safeConversationText.length > MAX_CONV_CHARS) {
      console.log(`Truncating conversation from ${safeConversationText.length} to ${MAX_CONV_CHARS} characters to respect token limits.`);
      const half = Math.floor(MAX_CONV_CHARS / 2);
      safeConversationText = safeConversationText.substring(0, half) + "\n\n...[CHAT TRUNCATED DUE TO API TOKEN LIMITS]...\n\n" + safeConversationText.substring(safeConversationText.length - half);
    }

    console.log(`Detecting chat category locally...`);
    const detectedCategory = detectChatCategory(safeConversationText);
    console.log(`Detected Category: ${detectedCategory}`);
    
    // Use compressed prompt for DeepSeek R1 to fit within token limits, full prompt for everything else
    const activeSystemPrompt = isR1
      ? buildCompressedSystemPromptForR1(projectCards, detectedCategory)
      : buildSystemPrompt(projectCards, detectedCategory, restrictionLevel);

    // Build the analysis user message — compressed version for R1 to save tokens
    const analysisUserMessage = isR1
      ? `Analyze this chat. Return ONLY valid JSON matching the schema. No markdown, no reasoning text.\n\n${safeConversationText}`
      : `Analyze this conversation:\n\n${safeConversationText}\n\n**CRITICAL INSTRUCTION**: Perform a thorough step-by-step QA analysis of the conversation above. Strictly adhere to all rules in the JSON knowledge base. You must evaluate every applicable rule and provide detailed explanations. Check for: missing mandatory information gathering, repeated questions, AHT delays, misleading guidance, and unverified claims.\n\n**CRITICAL LIMIT**: You MUST extract a maximum of 4 pairs (up to 8 messages total) for your criticalChatLogs array, focusing ONLY on the exact moment the sensitive error occurred. Output your final response ONLY as a valid JSON object matching the requested schema exactly.`;

    // Debug: Log estimated token usage for R1
    if (isR1) {
      const totalChars = activeSystemPrompt.length + analysisUserMessage.length;
      const estimatedTokens = Math.ceil(totalChars / 4);
      console.log(`[DeepSeek R1] System prompt: ${activeSystemPrompt.length} chars, User message: ${analysisUserMessage.length} chars, Total: ${totalChars} chars (~${estimatedTokens} tokens)`);
    }
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
    
    let parsedJson;
    try {
      parsedJson = JSON.parse(cleanedResponse);
    } catch (err) {
      try {
        // Fallback 1: Extract substring (for trailing markdown)
        const firstBrace = cleanedResponse.indexOf('{');
        const lastBrace = cleanedResponse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
          parsedJson = JSON.parse(cleanedResponse.substring(firstBrace, lastBrace + 1));
        } else {
          throw err;
        }
      } catch (e2) {
        // Fallback 2: Truncated JSON repair (for context limits)
        try {
          let repaired = cleanedResponse.trim();
          let openBraces = 0, openBrackets = 0, inString = false, escape = false;
          for (let i = 0; i < repaired.length; i++) {
            let c = repaired[i];
            if (escape) { escape = false; continue; }
            if (c === '\\') { escape = true; continue; }
            if (c === '"') { inString = !inString; continue; }
            if (!inString) {
              if (c === '{') openBraces++;
              if (c === '}') openBraces--;
              if (c === '[') openBrackets++;
              if (c === ']') openBrackets--;
            }
          }
          if (inString) repaired += '"';
          while (openBrackets > 0) { repaired += ']'; openBrackets--; }
          while (openBraces > 0) { repaired += '}'; openBraces--; }
          parsedJson = JSON.parse(repaired);
        } catch (e3) {
          console.error('Failed to repair JSON. Truncation too severe or format invalid.');
          throw err; // Throw the original parse error
        }
      }
    }
    
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
