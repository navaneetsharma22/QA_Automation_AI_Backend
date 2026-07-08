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
// UPGRADED: Expert Policy-Based QA Analysis Engine
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
        // Always keep Global rules — they apply to every conversation regardless of category
        if (r.category === 'Global') return true;
        
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
    
    if (restrictionLevel === 1 && categoryContextString.length > 2000) {
      categoryContextString = categoryContextString.substring(0, 2000) + '\n...[TRUNCATED]';
    } else if (restrictionLevel === 2 && categoryContextString.length > 300) {
      categoryContextString = categoryContextString.substring(0, 300) + '\n...[TRUNCATED]';
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

  const defaultOutputSchema = `{"qaScore":0-100,"status":"Passed|Warning|Failed","misleadingPercentage":0-100,"petitionId":"PET ID or null","agentName":"name or null","customerName":"name or null","customerIssue":"issue","issueCategory":"category","errorType":"type","overallRecommendation":"summary","qaFinding":"finding","applicableSop":"SOP","failureCondition":"condition or None","rootCause":"cause or None","criticalChatLogs":[{"speaker":"REAL NAME (Role)","message":"text"}],"findings":[{"ruleName":"rule","status":"Pass|Fail|Not Applicable","description":"desc","explanation":"why","evidence":["quote"]}],"expectedAgentAction":["action"],"agentAction":"what agent did","missingExpectedAction":"missing or None","ahtAnalysis":{"result":"result","timeline":["HH:MM"],"observation":"obs"},"reason":"50-90 words","qaConclusion":{"status":"QA Passed|QA Failed","misleading":"Yes|No","severity":"None|Low|Moderate|High|Critical","observations":["obs"],"decision":"verdict"}}`;

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

  let rulesString = (corendonRules.rules || [])
    .map(r => `${r.id}:${r.title}`)
    .join('|');
  if (rulesString.length > 2000) {
    rulesString = rulesString.substring(0, 2000) + '|...';
  }

  return `
# Chat Analysis System Prompt (Expert Policy-Based QA Analysis Engine)

## Role
You are a **Senior Quality Assurance Analyst with 10+ years of experience** in customer support QA for Corendon Airlines.
Your expertise is in policy-based analysis, not generic summarization. Every finding must be derived from the actual conversation and the configured SOP/Policy.
Your primary objective is ACCURATE evaluation — correctly identifying genuine QA issues AND correctly passing compliant conversations with EQUAL confidence. A false-positive QA failure (incorrectly failing a conversation that follows SOP) is EQUALLY as damaging as missing a real issue. You must be just as confident in generating "No QA Issue" as you are in identifying genuine problems. Evaluate conversations through evidence-based, context-aware reasoning by strictly comparing the full conversation against the provided JSON knowledge base.

## Expert QA Analyst Principles
- Never generate generic observations or conclusions that could apply to almost any conversation.
- Every finding must be conversation-specific and derived from actual agent behavior.
- Compare the agent's actions against the expected SOP before producing any conclusion.
- Explain WHY the action violates or complies with the policy.
- Reference the exact customer and agent messages that support the finding.
- If no policy violation exists, explicitly state that the agent followed the required SOP.
- Never invent violations or use template responses.
- Think like an experienced QA auditor: understand customer intent, follow chronology, detect SOP violations, validate policy, avoid false positives and hallucinations, select concise logs, explain impact, generate evidence-based findings.

---
## PRIMARY QA PRINCIPLE: VERIFICATION-FIRST
Always answer ONE question first: **"Did the agent actually verify the customer's situation before giving the answer?"**
If NO → Critical QA Failure. If YES → Continue evaluation. Never assume, never infer, never invent policy.

---
## ⚙️ MANDATORY RULE ENGINE — EVALUATE EVERY RULE ON EVERY CONVERSATION

The following 20 rules are MANDATORY. You MUST evaluate ALL of them for EVERY conversation without exception. Never skip a rule. Never invent policies. Never assume missing information.

### MANDATORY GLOBAL RULES (evaluate ALL 20 for every conversation)

| # | Rule Name | Evaluation Requirement |
|---|-----------|------------------------|
| 1 | Customer Issue Identification | Did the agent correctly identify the customer's PRIMARY issue before responding? |
| 2 | Customer Name Accuracy | Did the agent use the correct customer name throughout? |
| 3 | Agent Identity (Alias) Verification | Did the agent use only their assigned alias — never their own real name in introduction, sign-off, or self-reference? |
| 4 | Customer Addressing (Name or Flyer) | Did the agent address the customer by name or as "Flyer" at least once? |
| 5 | Original Question Resolution | Was the customer's original question fully resolved? |
| 6 | SOP Compliance | Did the agent follow all applicable Corendon Airlines SOPs? |
| 7 | Misleading Information | Did the agent provide any misleading, incorrect, or unverified information? |
| 8 | False Commitment | Did the agent make any promise or commitment without backend verification? |
| 9 | Policy Violation | Did the agent contradict or bypass any Corendon Airlines policy? |
| 10 | Critical Error Detection | Did any agent action constitute a Critical Error per the defined error types? |
| 11 | Communication Quality | Was the agent's communication clear, professional, and appropriate? |
| 12 | Complete vs Partial Resolution | Was the resolution complete, partial, or unresolved? |
| 13 | Escalation Requirement | Was escalation required? If yes, was it performed correctly (internal Tier 1→2→3)? |
| 14 | Response Time (ART) | Were there any response delays exceeding 4 minutes without a customer update? |
| 15 | Correct Issue Identification Before Guidance | Did the agent correctly identify the customer's issue BEFORE providing any guidance? |
| 16 | No Forced Tier 3 Resolution | Did the agent avoid forcefully resolving a case that required Tier 3 verification? |
| 17 | No Unauthorized Backend Claim | Did the agent avoid claiming backend/system verification without authorization? |
| 18 | No Booking Assumption | Did the agent avoid guessing or assuming any booking information? |
| 19 | No Policy Contradiction | Did the agent avoid contradicting Corendon Airlines company policy at any point? |
| 20 | No Hallucinated Information | Did the agent avoid providing hallucinated, invented, or fabricated information? |

**EVALUATION INSTRUCTION:** For each of the 20 rules above, generate a finding entry.
**OUTPUT SIZE RULE — CRITICAL FOR PERFORMANCE:**
- For rules with status **Pass** or **Not Applicable**: output ONLY {"ruleName":"<name>","status":"Pass"} or {"ruleName":"<name>","status":"Not Applicable"} — NO description, NO explanation, NO evidence. This is mandatory to reduce output size.
- For rules with status **Fail**: output the FULL 8-point structure with description, explanation, and evidence array.
- Use "Not Applicable" ONLY when the rule genuinely cannot apply. Use "Pass" when compliant. Use "Fail" only with DIRECT, UNAMBIGUOUS chat evidence.

### CATEGORY-SPECIFIC VALIDATION

After evaluating all 20 mandatory global rules, also evaluate the category-specific SOP rules that apply to the detected conversation category. Load and evaluate ONLY the SOPs relevant to the detected category in addition to the global rules.

Applicable categories and their specific validation focus:
- **Booking**: Payment verification, name change, PNR verification, booking source
- **Refund**: Booking source verification, refund eligibility, L3 escalation requirement
- **Cancellation**: Booking source verification, third-party vs direct booking handling
- **Reschedule**: Booking source, fare breakdown, L3 escalation for pricing
- **Payment**: Transaction verification, duplicate payment, L3 escalation
- **Promo Code**: Source verification (Corendon vs third-party), Tier 3 escalation, no unauthorized commitment
- **Lost Baggage**: PIR requirement, PIR cannot be online, return-to-airport advice, connecting flight verification
- **Damaged Baggage**: PIR at airport, connecting flight check, mixed-airline re-check guidance
- **Missing Baggage**: PIR mandatory, online PIR not possible, Lost & Found referral
- **Connecting Flight**: Baggage transfer rules (all-Corendon vs mixed-airline)
- **Travel Agency Booking**: Direct to booking partner, no direct processing
- **Check-in**: Online vs airport check-in distinction, correct guidance
- **Boarding Pass**: Scanning issue handling, no unauthorized boarding approval
- **Passenger Addition**: L3 escalation, no unauthorized confirmation
- **Password Reset**: Correct self-service guidance, no unauthorized account access
- **Airport Arrival**: Correct arrival procedure guidance
- **Compensation**: No unauthorized EU261 approval, L3 escalation
- **Flight Delay**: No unverified delay duration/reason, L3 escalation
- **Seat**: No guaranteed seat assignment, L3 escalation
- **Meal**: No confirmed meal processing without verification, L3 escalation
- **Special Assistance**: Correct escalation, no unauthorized commitment

### FINDING GENERATION — MANDATORY STRUCTURE

Generate findings ONLY from the mandatory rules above.
- **Pass/Not Applicable findings**: output ONLY ruleName + status. No other fields.
- **Fail findings**: MUST include all 8-point structure fields with exact chat evidence.

### REASON GENERATION — STRICT RULES

The 'reason' field in the final output MUST:
- NEVER praise the agent
- ONLY explain: policy violations, critical errors, missing verification, missing escalation, false commitments, misleading guidance, incorrect issue identification, wrong customer name, alias violations, SOP violations, forcefully resolved cases
- If NO issues exist, return EXACTLY: "No policy violations, misleading guidance, or critical errors were detected."
- Be 50-90 words, one paragraph, professional QA language
- Start with the agent's mistake -- NOT with the customer's issue
- Include the specific SOP reference and exact chat evidence for every violation

### SEVERITY CLASSIFICATION — AUTOMATIC

Classify every finding automatically based on customer impact and SOP violation:
- **Critical**: Unverified commitments, false information, unauthorized backend claims, wrong issue identification, forced Tier 3 resolution, hallucinated policy, incorrect flyer identification
- **High**: Missing mandatory escalation, booking source not verified for refund/cancel/reschedule, missing PIR guidance, incorrect baggage transfer guidance
- **Moderate**: Missing information gathering, incomplete troubleshooting, partial resolution, ART violation
- **Low**: Minor communication issues, customer addressing failure, alias minor observation
- **None**: Full compliance, no violations

### FINAL QA REPORT — MANDATORY FIELDS

Every report MUST include ALL of the following fields in the JSON output:
- petitionId: Petition Number extracted from the chat
- agentName: Agent Name extracted from the chat
- customerName: Customer Name extracted from the chat
- customerIssue: Customer Issue (primary issue identified)
- issueCategory: Issue Category (detected category)
- qaFinding: QA Finding summary
- findings: Array of all mandatory rule findings
- applicableSop: The primary SOP that applies to this conversation
- expectedAgentAction: Expected actions array
- agentAction: What the agent actually did
- failureCondition: The specific failure condition triggered, or None
- criticalChatLogs: Chat evidence (max 4 pairs)
- rootCause: Root cause of the failure, or None
- qaScore: QA Score (0-100)
- status: Passed | Warning | Failed
- misleadingPercentage: Misleading percentage
- qaConclusion.severity: Severity level (Critical | High | Moderate | Low | None)
- qaConclusion.status: QA Passed | QA Failed
- reason: QA Reason (following the strict reason generation rules above)

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
7. **Escalation is a valid resolution.** If the agent correctly identified that the issue requires Tier 3 (Dev/backend) verification and escalated appropriately, this is CORRECT behavior — not a failure.
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

### 4. Reason & Action Generation — Expert Policy-Based Analysis
Generate a concise, evidence-based "reason" field that explains ONLY the agent's mistakes and policy violations. The reason must focus exclusively on what went wrong and reference the specific SOP.

**REASON FIELD — STRICT RULES:**
- The "reason" field MUST contain ONLY agent mistakes, policy violations, critical errors, misleading guidance, missing mandatory verification, missing escalation, incorrect information, SOP violations, forcefully resolved cases, alias violations, or incorrect flyer identification.
- Do NOT praise the agent in the reason field.
- Do NOT summarize what the agent did correctly in the reason field.
- Do NOT mention successful actions in the reason field.
- Do NOT start with the customer's issue — start directly with the agent's mistake or violation.
- Keep between **50-90 words**, one concise paragraph in professional QA language.
- If NO issues were found (all findings are Pass), the reason field MUST be exactly: "No policy violations, misleading guidance, or critical errors were detected."

**REASON FIELD — REQUIRED CONTENT (only when issues exist):**
- State the specific policy violation or error directly.
- Reference the exact SOP or rule that was violated (e.g., "Per Cancellation SOP §2.1...").
- Include the direct chat evidence (exact quote of the agent's message).
- Explain the customer impact of the violation.
- Explain WHY this violates the policy (not just WHAT was violated).
- End with a concise QA conclusion.

**PROHIBITED in reason field:**
- Any mention of what the agent did correctly.
- Phrases like "the agent correctly...", "the agent successfully...", "the agent did well..."
- Positive summaries of any kind.
- Generic statements such as "The agent failed to provide helpful assistance" without citing the specific rule and evidence.
- Vague references to policy — always cite the specific SOP section or rule ID.

Also, when generating Expected Agent Actions in the JSON, generate issue-specific Expected Agent Actions instead of reusable templates.

### 5. Chat Log Selection — Evidence-Based
Generate only the minimum evidence required. Include only messages proving the finding (Customer intent, Agent response, Customer objection, Final response proving the issue).
Do NOT include Greetings, Waiting messages, Thank you messages, Duplicate information, or Irrelevant conversation.
Preferred size: 2-5 customer/agent exchanges. Every included message must directly support the finding.
**CRITICAL:** Every chat log must answer: "Does this message directly prove the QA finding?" If NO, exclude it.
**EXPERT PRINCIPLE:** Select the exact moment the agent made the mistake or violated the policy. Do not include context that doesn't directly support the violation.

### 6. EXPERT DECISION FLOW (8-Point Finding Structure)
For every QA finding, include these 8 elements:

**1. Expected SOP / Policy:** State the specific SOP rule that applies to this scenario (e.g., "Per Cancellation SOP §2.1: Agent must verify booking source before providing cancellation guidance").

**2. Actual Agent Action:** Describe what the agent actually did based on direct chat evidence (not assumptions).

**3. Evidence (Quoted Conversation):** Include the exact agent message(s) that prove the finding. Use direct quotes.

**4. Policy Comparison:** Explicitly compare the agent's action against the SOP. State whether the action complies, partially complies, or violates the policy.

**5. Customer Impact:** Explain how the customer was affected (e.g., Extra effort, Delay, Confusion, False expectations, Financial risk, Operational misunderstanding). Avoid generic statements.

**6. QA Risk:** Identify the business risk (e.g., Compliance violation, Escalation required, Potential complaint, Compensation risk).

**7. Severity Justification:** Explain WHY this severity was assigned (e.g., "Critical because the agent made an unverified commitment that could result in customer harm").

**8. Recommended Correct Action:** State what the agent should have done instead.

**HUMAN DECISION FLOW (3-Step Framework)**
**Step 1: Identify the customer's REAL issue.** Ignore the ticket category. Find the actual problem based on the customer's words (e.g. "I can't cancel" = Cancellation).
**Step 2: Check whether the agent correctly understood the issue.** If the agent answers a different issue = Critical Failure.
**Step 3: Determine whether verification was REQUIRED.** General FAQs usually don't require verification. Booking-specific, refunds, compensation, cancellation, reschedule, and baggage issues ALWAYS require verification before answering.

### 13. Consistency Validation — Expert QA Audit
Validate that every Fail has direct evidence, every conclusion matches the SOP, and the reason field contains only violations. Pass/Not Applicable findings must be compact: output only {"ruleName":"...","status":"Pass"} or {"ruleName":"...","status":"Not Applicable"}.

### 14. Hallucination Prevention
Never invent SOPs, escalation paths, customer actions, agent capabilities, or airline policy. If a fact is missing, write "Not established in the conversation." Do not guess.

### 15. Confidence Validation
Use conservative conclusions when evidence is ambiguous. If you are not sure, prefer Pass.

### 16. Final Goal — Expert Policy-Based QA Analysis
Think like a **Senior QA Auditor with 10+ years of experience**. Your analysis must stay conversation-specific, policy-justified, evidence-based, and aligned to the JSON schema.

## Compact Policy Reference
- Rule 13 escalation: never tell the flyer to call external support; use internal escalation only unless the issue is third-party booking guidance.
- Rule 3 alias: fail only if the system shows the agent's own real name and the chat uses that same name in self-introduction, sign-off, or direct self-reference. Mentions of other names, nationalities, regions, or customer names are not alias violations.
- Rule 2 flyer name: fail only when the agent uses a clearly different customer name.
- Rules 1 and 15: identify the primary issue before giving guidance; clarifying questions are allowed.
- Promo code handling: if a promo code is mentioned, verify source before guidance; Corendon-issued promo codes require Tier 3 escalation, third-party codes go back to the issuer.
- Rule 4 addressing: using the customer name or "Flyer" once is sufficient; no standalone fail.
- Cancellation contradiction: if the agent first says refund or rebooking is automatic, then later says the customer must use the cancellation email to choose between refund or rebooking, treat that as contradictory guidance and a policy failure. The agent must stay consistent about whether action is required.
- Cancellation contradiction: if the agent first says refund or rebooking is automatic, then later says the cancellation email gives the customer a choice between refund or rebooking, mark it as a contradictory-information failure unless the earlier statement is clearly corrected immediately.

---
## Special Cases — Expert QA Standards
* If no errors found: "status": "Passed", "qaScore" 90-100, "qaFinding": "No QA Error Found"
* If minor observations only: "status": "Passed", "qaScore" 85-95
* Never force "Failed" when no genuine SOP violation exists
* For PASS findings: State which SOP rule was followed
* For NO ISSUES: Explain what agent did correctly, reference SOP, confirm no misleading info

## Logical Consistency
- Fail → qaConclusion.status = "QA Failed", top-level status = "Failed" or "Warning"
- All Pass → qaConclusion.status = "QA Passed", status = "Passed", qaScore >= 85
- When in doubt, PASS

## Output Requirements
Return ONLY JSON matching schema. No Markdown outside JSON.

## Critical Chat Logs (MAX 4 PAIRS / 8 MESSAGES)
1. LIMIT: 4 exchanges maximum
2. Hunt for sensitive error moment only
3. No full chat dumps
4. Exclude noise: greetings, closings, holding messages
5. Evidence only: customer intent, agent response, customer reaction
6. USE REAL NAMES: "Dennis (Agent)" or "Makayla Mendoza (Customer)" — NOT "Agent"/"Customer"
7. Every log must answer: "Does this prove the finding?" If NO, exclude it

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
        if (r.category === 'Global') return true;
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
    : 'AHT: late response; MISLEADING: false info; CRITICAL: severe violation';

  const compactRules = (corendonRules.rules || []).map((rule) => {
    const title = rule.title || rule.name || rule.id || 'rule';
    const summary = (rule.description || rule.policy || rule.requirement || '').replace(/\s+/g, ' ').trim();
    return summary ? `${title}: ${summary}` : title;
  }).join(' | ');

  let categoryContextString = '';
  if (promptContext.globalInstructions !== undefined) {
    categoryContextString = (promptContext.globalInstructions || '').replace(/\s+/g, ' ').trim();
  } else {
    categoryContextString = Object.entries(promptContext).map(([category, data]) => {
      if (category === '_GlobalExample') return '';
      if (!data.globalInstructions && !data.perfectExample) return '';
      if (detectedCategory && detectedCategory !== 'Auto-Detect' && detectedCategory !== 'Other' && detectedCategory !== 'Random (Any Issue)') {
        if (category !== detectedCategory) return '';
      }
      let str = `${category}: `;
      if (data.globalInstructions) str += data.globalInstructions.replace(/\s+/g, ' ').trim();
      return str;
    }).filter(s => s).join(' | ');
  }

  if (categoryContextString.length > 300) {
    categoryContextString = categoryContextString.substring(0, 300) + '...[TRUNCATED]';
  }

  let rulesString = compactRules;
  if (rulesString.length > 700) {
    rulesString = rulesString.substring(0, 700) + '...[TRUNCATED]';
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
    ? `{"qaScore":0-100,"status":"Passed|Warning|Failed","misleadingPercentage":0-100,"petitionId":"PET ID or null","agentName":"name or null","errorType":"type","overallRecommendation":"summary","findings":[${JSON.stringify(dynamicFindingSchema)}]}`
    : `{"qaScore":0-100,"status":"Passed|Warning|Failed","misleadingPercentage":0-100,"petitionId":"PET ID or null","agentName":"name or null","customerName":"customer full name or null","customerIssue":"primary issue","issueCategory":"category","errorType":"error category","overallRecommendation":"summary","qaFinding":"No QA Error Found or main finding","applicableSop":"primary SOP rule","failureCondition":"specific failure or None","rootCause":"root cause or None","criticalChatLogs":[{"speaker":"REAL NAME (Role)","message":"exact text"}],"findings":[{"ruleName":"rule","description":"what agent did","status":"Pass|Fail|Not Applicable","explanation":"why","evidence":["quote"]}],"expectedAgentAction":["action"],"agentAction":"what agent did","missingExpectedAction":"what was missing or None" ,"ahtAnalysis":{"result":"result","timeline":["HH:MM→HH:MM"],"observation":"obs"},"reason":"80-140 words, one natural paragraph, professional human QA language, focused on the specific violations, policy reference, evidence, and customer impact; do not sound robotic","qaConclusion":{"status":"QA Passed|QA Failed","misleading":"Yes|No","severity":"None|Low|Moderate|High|Critical","observations":["obs"],"decision":"verdict"}}`;

  const bookingSourceNote = ['Booking', 'Cancellation', 'Reschedule', 'Refund'].includes(detectedCategory)
    ? `\nBOOKING SOURCE: For ${detectedCategory} queries, check if agent verified booking source (direct vs third-party) per SOP. Only fail if SOP requires it AND agent skipped it AND it led to incorrect guidance.`
    : '';

  return `# DeepSeek-R1 QA Prompt
Role: senior QA analyst. Stay evidence-based, conversation-specific, and JSON-only.

Rules: evaluate the 20 mandatory rules, but keep output compact. Use Pass/Not Applicable when compliant. Use Fail only with direct evidence.

DeepSeek focus: false commitments, misleading assistance, incorrect escalation, alias/name issues, wrong issue identification, and hallucinated info are the highest-risk checks. For baggage, prioritize PIR/return-to-airport/transfer guidance and booking-source verification.

Cancellation contradiction: if the agent says refund or rebooking is automatic and later says the customer must use the cancellation email to choose between refund or rebooking, treat that as a failure unless the agent explicitly corrects the earlier statement in the same exchange.

Conversation limits: use max 4 chat pairs, avoid noise, and cite only the exact messages proving the finding.

Reason style: write the reason like a real senior auditor would. Use a natural, fluent paragraph, not shorthand. Explain the violation, the exact policy issue, the concrete evidence, and the customer impact. If there are multiple violations, connect them cleanly in one paragraph.

Global rules: ${rulesString}

${categoryContextString ? `Category context: ${categoryContextString}
` : ''}Error types: ${errorTypesString}

${bookingSourceNote}

Output schema: ${outputSchema}`;
};

const buildCompressedSystemPromptForMini = (projectCards, detectedCategory) => {
  const prompt = buildCompressedSystemPromptForR1(projectCards, detectedCategory);
  return prompt
    .replace('# DeepSeek-R1 QA Prompt', '# GPT-4o-mini QA Prompt')
    .replace('Reason style: write the reason like a real senior auditor would. Use a natural, fluent paragraph, not shorthand. Explain the violation, the exact policy issue, the concrete evidence, and the customer impact. If there are multiple violations, connect them cleanly in one paragraph.', 'Reason style: write a natural, fluent paragraph that sounds like a real QA reviewer. Keep it detailed but readable, and clearly explain the violation, policy issue, evidence, and customer impact.')
    .replace('"reason":"80-140 words, one natural paragraph, professional human QA language, focused on the specific violations, policy reference, evidence, and customer impact; do not sound robotic"', '"reason":"100-160 words, one natural paragraph, professional human QA language, focused on the specific violations, policy reference, evidence, and customer impact; sound like a real auditor and avoid robotic phrasing"');
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
  cleaned = cleaned.replace(/^\d{1,2}\s+[A-Za-z]{3},\s+\d{2}:\d{2}\s+[ap]m\s+IST\r?\n?/gm, '');
  cleaned = cleaned.replace(/^\[\d{2}:\d{2}\s+[ap]m\]\s*/gm, '');
  cleaned = cleaned.replace(/^(about\s+)?\d+\s+(minute|hour)s?\s+ago\r?\n?/gm, '');
  cleaned = cleaned.replace(/^[A-Z]\r?\n/gm, '');
  cleaned = cleaned.replace(/^.*has accepted this query.*\s*/gm, '');
  cleaned = cleaned.replace(/^Your query has been escalated.*\s*/gm, '');
  cleaned = cleaned.replace(/^Transfer from.*accepted by.*\s*/gm, '');
  cleaned = cleaned.replace(/^(Reason|Concern|Steps Performed|Reason for Escalation):.*\s*/gm, '');
  cleaned = cleaned.replace(/thank you for contacting.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/welcome to.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/is there anything else.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/have a great (day|evening|night|weekend).*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/(please wait|please hold|allow me|give me).*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/i (am|will be|have been).*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/looking forward to.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/appreciate your.*?(\.|\!|\?)\s?/gi, '');
  cleaned = cleaned.replace(/best regards.*?(\.|\!|\?)\s?/gi, '');
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
    const isMini = (aiModel || '').toLowerCase().includes('gpt-4o-mini');
    const isGitHub = providerName.includes('GITHUB');
    const isGroq = providerName.includes('GROQ');
    const isCerebras = providerName.includes('CEREBRAS');
    const isDeepSeek = providerName.includes('DEEPSEEK');
    const isGitHubR1 = isGitHub && isR1;
    const isOpenRouterR1 = providerName.includes('OPENROUTER') && isR1;
    const isHuggingFaceR1 = providerName.includes('HUGGING') && isR1;
    const isAnyR1 = isR1 || isGitHubR1 || isOpenRouterR1 || isHuggingFaceR1;
    const restrictionLevel = isAnyR1 ? 2 : ((isMini || isGitHub || isGroq || isCerebras || isDeepSeek) ? 1 : 0);

    let MAX_CONV_CHARS = 45000;
    if (isAnyR1) MAX_CONV_CHARS = 3500;
    else if (isMini || isGitHub) MAX_CONV_CHARS = 3000;
    else if (isCerebras || isDeepSeek) MAX_CONV_CHARS = 4000;
    else if (isGroq) MAX_CONV_CHARS = 6000;
    
    if (safeConversationText.length > MAX_CONV_CHARS) {
      console.log(`Truncating conversation from ${safeConversationText.length} to ${MAX_CONV_CHARS} characters to respect token limits.`);
      const half = Math.floor(MAX_CONV_CHARS / 2);
      safeConversationText = safeConversationText.substring(0, half) + "\n\n...[CHAT TRUNCATED DUE TO API TOKEN LIMITS]...\n\n" + safeConversationText.substring(safeConversationText.length - half);
    }

    console.log(`Detecting chat category locally...`);
    const detectedCategory = detectChatCategory(safeConversationText);
    console.log(`Detected Category: ${detectedCategory}`);
    
    const activeSystemPrompt = buildCompressedSystemPromptForR1(projectCards, detectedCategory, restrictionLevel);

    const analysisUserMessage = `Analyze this chat as a Senior QA Analyst. Evaluate ALL 20 rules. Return ONLY valid JSON matching the schema. No markdown, no extra text.\n\n${safeConversationText}`;

    const totalChars = activeSystemPrompt.length + analysisUserMessage.length;
    console.log(`[${providerName}/${aiModel}] Prompt: ${activeSystemPrompt.length} chars, Msg: ${analysisUserMessage.length} chars, Total: ~${Math.ceil(totalChars / 4)} tokens`);
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
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          completion = await groq.chat.completions.create({
            messages: [
              { role: 'system', content: activeSystemPrompt },
              { role: 'user', content: analysisUserMessage }
            ],
            model: aiModel || 'llama-3.3-70b-versatile',
            temperature: 0,
            response_format: { type: 'json_object' },
            max_tokens: 2000
          });
          break;
        } catch (err) {
          retries++;
          if (retries >= 2) throw err;
          console.log(`Groq retry ${retries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      rawResponse = completion.choices[0].message.content;
    } 
    else if (providerName.includes('GEMINI') || providerName.includes('GOOGLE')) {
      const genAI = getGeminiClient(customKey);
      const isFlash25 = (aiModel || 'gemini-2.5-flash').includes('2.5-flash');
      const model = genAI.getGenerativeModel({ 
        model: aiModel || 'gemini-2.5-flash',
        generationConfig: {
          responseMimeType: 'application/json',
          ...(isFlash25 ? { thinkingConfig: { thinkingBudget: 0 } } : {})
        }
      });
      let geminiResult;
      try {
        geminiResult = await model.generateContent(`${activeSystemPrompt}\n\n${analysisUserMessage}`);
      } catch (geminiErr) {
        if (geminiErr.status === 503) {
          console.log('Gemini 503 — retrying in 10s...');
          await new Promise(r => setTimeout(r, 10000));
          geminiResult = await model.generateContent(`${activeSystemPrompt}\n\n${analysisUserMessage}`);
        } else {
          throw geminiErr;
        }
      }
      rawResponse = geminiResult.response.text();
    }
    else if (providerName.includes('OPENAI')) {
      const openai = getOpenAiClient(customKey);
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          completion = await openai.chat.completions.create({
            messages: [
              { role: 'system', content: activeSystemPrompt },
              { role: 'user', content: analysisUserMessage }
            ],
            model: aiModel || 'gpt-4o',
            temperature: 0,
            response_format: { type: 'json_object' },
            max_tokens: 2000
          });
          break;
        } catch (err) {
          retries++;
          if (retries >= 2) throw err;
          console.log(`OpenAI retry ${retries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('ANTHROPIC')) {
      const anthropic = getAnthropicClient(customKey);
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          completion = await anthropic.messages.create({
            model: aiModel || 'claude-3-5-sonnet-20241022',
            max_tokens: 2000,
            temperature: 0,
            system: activeSystemPrompt,
            messages: [{ role: 'user', content: analysisUserMessage }]
          });
          break;
        } catch (err) {
          retries++;
          if (retries >= 2) throw err;
          console.log(`Anthropic retry ${retries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      rawResponse = completion.content[0].text;
    }
    else if (providerName.includes('DEEPSEEK')) {
      const deepseek = new OpenAI({ 
        apiKey: customKey || process.env.DEEPSEEK_API_KEY || 'no-key',
        baseURL: 'https://api.deepseek.com/v1' 
      });
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          completion = await deepseek.chat.completions.create({
            messages: [
              { role: 'system', content: activeSystemPrompt },
              { role: 'user', content: analysisUserMessage }
            ],
            model: aiModel || 'deepseek-chat',
            temperature: 0,
            response_format: { type: 'json_object' },
            max_tokens: 2000
          });
          break;
        } catch (err) {
          retries++;
          if (retries >= 2) throw err;
          console.log(`DeepSeek retry ${retries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
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
        response_format: { type: 'json_object' },
        max_tokens: 2000
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
        max_tokens: 2000,
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
        temperature: 0,
        max_tokens: 2000
      });
      rawResponse = completion.choices[0].message.content;
    }
    else if (providerName.includes('CEREBRAS')) {
      const cerebras = new OpenAI({
        apiKey: customKey || process.env.CEREBRAS_API_KEY || 'no-key',
        baseURL: 'https://api.cerebras.ai/v1',
        timeout: 60000
      });
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          completion = await cerebras.chat.completions.create({
            messages: [
              { role: 'system', content: activeSystemPrompt },
              { role: 'user', content: analysisUserMessage }
            ],
            model: aiModel || 'llama-3.3-70b',
            temperature: 0,
            max_tokens: 2000,
            response_format: { type: 'json_object' }
          });
          if (completion && completion.choices && completion.choices[0] && completion.choices[0].message) {
            rawResponse = completion.choices[0].message.content;
          }
          break;
        } catch (err) {
          retries++;
          if (retries >= 2) throw err;
          console.log(`Cerebras retry ${retries}...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    else if (providerName.includes('COHERE')) {
      const cohere = getCohereClient(customKey);
      const completion = await cohere.chat({
        message: analysisUserMessage,
        preamble: activeSystemPrompt,
        model: aiModel || 'command-a-plus-05-2026',
        temperature: 0,
        max_tokens: 2000
      });
      rawResponse = completion.text;
    }
    else if (providerName.includes('GITHUB')) {
      const github = new OpenAI({
        apiKey: customKey || process.env.GITHUB_API_KEY || 'no-key',
        baseURL: 'https://models.inference.ai.azure.com'
      });
      const requestedGithubModel = (aiModel || 'gpt-4o-mini');
      let normalizedGithubModel = requestedGithubModel.toLowerCase().includes('405b') ? 'gpt-4o-mini' : requestedGithubModel;
      let retries = 0;
      let completion;
      while (retries < 2) {
        try {
          const isR1Model = normalizedGithubModel.toLowerCase().includes('r1') || normalizedGithubModel.toLowerCase().includes('deepseek');
          completion = await github.chat.completions.create({
            messages: [
              { role: 'system', content: activeSystemPrompt },
              { role: 'user', content: analysisUserMessage }
            ],
            model: normalizedGithubModel,
            temperature: 0,
            max_tokens: 2000,
            ...(isR1Model ? {} : { response_format: { type: 'json_object' } })
          });
          break;
        } catch (err) {
          if (err.status === 400 && err.code === 'unknown_model') {
            console.warn(`GitHub Models: "${normalizedGithubModel}" not found. Falling back to gpt-4o-mini.`);
            normalizedGithubModel = 'gpt-4o-mini';
            retries++;
            continue;
          }
          if (err.status === 413) {
            throw new Error(`GitHub Models token limit exceeded for "${normalizedGithubModel}". Try gpt-4o-mini or reduce conversation length.`);
          }
          retries++;
          if (retries >= 2) throw err;
          console.log(`GitHub Models retry ${retries}...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
      rawResponse = completion.choices[0].message.content;
    }
    else {
      return res.status(400).json({ error: 'Unsupported AI Provider: ' + providerName });
    }

    // Attempt to parse JSON (some models might still include markdown despite instructions)
    if (!rawResponse) {
      console.error('No response received from AI provider');
      return res.status(500).json({ 
        error: 'No response from AI provider',
        details: 'The AI provider returned an empty response',
        provider: providerName,
        model: aiModel
      });
    }
    let cleanedResponse = rawResponse.trim();
    
    // Remove DeepSeek-R1 reasoning tags — two-pass: complete blocks first, then orphaned opening tags
    cleanedResponse = cleanedResponse.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    cleanedResponse = cleanedResponse.replace(/<think>[\s\S]*/gi, '').trim();

    // Remove markdown code blocks
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '');
    }
    
    // Sanitize bad Unicode escapes
    cleanedResponse = cleanedResponse.replace(/\\u(?![0-9a-fA-F]{4})/g, 'u');
    
    // Remove trailing commas
    cleanedResponse = cleanedResponse.replace(/,\s*([}\]])/g, '$1');

    // Extract only the first complete JSON object (handles models that output multiple JSON blocks)
    {
      const start = cleanedResponse.indexOf('{');
      if (start !== -1) {
        let depth = 0, inStr = false, esc = false, end = -1;
        for (let i = start; i < cleanedResponse.length; i++) {
          const ch = cleanedResponse[i];
          if (esc) { esc = false; continue; }
          if (ch === '\\' && inStr) { esc = true; continue; }
          if (ch === '"') { inStr = !inStr; continue; }
          if (!inStr) {
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
          }
        }
        if (end !== -1) cleanedResponse = cleanedResponse.substring(start, end + 1);
      }
    }
    
    let parsedJson;
    try {
      parsedJson = JSON.parse(cleanedResponse);
    } catch (err) {
      try {
        const firstBrace = cleanedResponse.indexOf('{');
        const lastBrace = cleanedResponse.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
          parsedJson = JSON.parse(cleanedResponse.substring(firstBrace, lastBrace + 1));
        } else {
          throw err;
        }
      } catch (e2) {
        try {
          let repaired = cleanedResponse.trim();
          const firstBrace = repaired.indexOf('{');
          if (firstBrace === -1) throw new Error('No JSON object found');
          repaired = repaired.substring(firstBrace);
          
          let openBraces = 0, openBrackets = 0, inString = false, escape = false;
          let lastValidPos = -1;
          let lastCloseBracePos = -1;
          let result = '';
          
          for (let i = 0; i < repaired.length; i++) {
            let c = repaired[i];
            
            if (escape) {
              if (c === 'u') {
                const hexChars = repaired.substring(i + 1, i + 5);
                if (/^[0-9a-fA-F]{4}/.test(hexChars)) {
                  result += c;
                  escape = false;
                } else {
                  result += 'u';
                  escape = false;
                }
              } else {
                result += c;
                escape = false;
              }
              continue;
            }
            
            if (c === '\\') {
              result += c;
              escape = true;
              continue;
            }
            
            if (c === '"') {
              inString = !inString;
              result += c;
              continue;
            }
            
            if (!inString) {
              if (c === '{') {
                openBraces++;
                lastCloseBracePos = -1;
              }
              if (c === '}') {
                openBraces--;
                lastCloseBracePos = i;
                if (openBraces === 0) lastValidPos = i;
              }
              if (c === '[') openBrackets++;
              if (c === ']') openBrackets--;
            }
            
            result += c;
          }
          
          if (lastValidPos !== -1) {
            repaired = result.substring(0, lastValidPos + 1);
          } else if (lastCloseBracePos !== -1) {
            repaired = result.substring(0, lastCloseBracePos + 1);
          } else {
            if (inString) repaired = result + '"';
            else repaired = result;
            while (openBrackets > 0) { repaired += ']'; openBrackets--; }
            while (openBraces > 0) { repaired += '}'; openBraces--; }
          }
          
          parsedJson = JSON.parse(repaired);
        } catch (e3) {
          console.error('Failed to repair JSON. Truncation too severe or format invalid.');
          console.error('Error details:', e3.message);
          throw err;
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
    
    const fallbackResponse = {
      qaScore: 0,
      status: 'Failed',
      misleadingPercentage: 0,
      petitionId: null,
      agentName: null,
      customerName: null,
      customerIssue: 'Unable to analyze',
      issueCategory: 'Other',
      errorType: 'System Error',
      overallRecommendation: 'Analysis failed due to response parsing error',
      qaFinding: 'Analysis Error',
      applicableSop: 'N/A',
      failureCondition: 'JSON parsing failed',
      rootCause: error.message,
      criticalChatLogs: [],
      findings: [],
      expectedAgentAction: [],
      agentAction: 'N/A',
      missingExpectedAction: 'N/A',
      ahtAnalysis: {
        result: 'Unable to analyze',
        timeline: [],
        observation: 'Analysis failed'
      },
      reason: `Analysis failed: ${error.message}`,
      qaConclusion: {
        status: 'QA Failed',
        misleading: 'Unknown',
        severity: 'Critical',
        observations: ['JSON parsing error during analysis'],
        decision: 'Unable to complete QA analysis due to system error.'
      }
    };
    
    return res.status(500).json({ 
      error: 'Failed to analyze conversation', 
      details: error.message,
      fallback: fallbackResponse
    });
  }
};
