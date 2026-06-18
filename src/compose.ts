import type { InboxItem } from "./types.js";
import type {
  ComposeResult,
  OrchestrationFacts,
  Understanding,
} from "./triage-types.js";
import { callStructured, isLLMEnabled } from "./llm.js";
import { draft_message } from "./tools.js";

/**
 * Stage 3 — compose the human-facing draft and the audit narrative, now that
 * Stage 2 has produced real tool results. The LLM writes the empathetic prose;
 * deterministic code decides the channel/recipient and whether a draft is even
 * appropriate, then calls `draft_message`. A templated fallback covers the
 * no-LLM path.
 *
 * Drafts must never give clinical advice and never imply a message was sent or
 * an appointment booked.
 */

type Channel = "portal" | "email" | "phone";

interface LlmCompose {
  draft_reply: string | null;
  recommended_next_action: string;
  decision_rationale: string;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["draft_reply", "recommended_next_action", "decision_rationale"],
  properties: {
    draft_reply: { type: ["string", "null"] },
    recommended_next_action: { type: "string" },
    decision_rationale: { type: "string" },
  },
};

const SYSTEM = `You write the human-facing draft reply and the internal triage narrative for Cedar Kids Therapy, a pediatric therapy practice. A teammate reviews everything before anything is sent — you are drafting, not sending.

Hard rules for draft_reply:
- Clear, warm, empathetic, concise. Address the family by name when known.
- NEVER give clinical advice or opinions. For clinical questions, acknowledge and offer a screening/evaluation as the next step.
- NEVER imply the message was already sent, or that an appointment is booked/confirmed. A held slot is "pending" and "a team member will confirm".
- Write in the family's language (English or Spanish) as indicated.
- For a safeguarding item: write ONLY a brief, neutral acknowledgement that the message was received and a team member will follow up. Do NOT mention abuse/harm, do NOT ask investigative questions, do NOT give advice.
- Reflect the real situation you are given: if insurance is out-of-network or expired, say billing will follow up before scheduling; if information is missing, request exactly those items; if a slot is on pending hold, say a team member will confirm it.
- No signature block, no placeholders like [Name]. 2-5 sentences.

recommended_next_action: one sentence, operational, for staff (who does what next). Agents never book or send.
decision_rationale: 1-3 sentences explaining the classification, urgency, and why these tools/actions were chosen, referencing policy where relevant.

Return only the structured object.`;

export async function compose(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<ComposeResult> {
  const wantsDraft = facts.scenario !== "spam";
  const channel = pickChannel(item, u);
  const recipient = pickRecipient(item, u);

  let result: LlmCompose;
  if (isLLMEnabled()) {
    try {
      result = await callStructured<LlmCompose>({
        system: SYSTEM,
        user: buildContext(item, u, facts, channel),
        schema: SCHEMA,
        maxTokens: 900,
      });
    } catch (error) {
      console.error(
        `compose(${item.id}) fell back to template: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      result = templateCompose(u, facts);
    }
  } else {
    result = templateCompose(u, facts);
  }

  let draftReply: string | null = null;
  if (wantsDraft && result.draft_reply) {
    draftReply = result.draft_reply;
    await draft_message({
      recipient,
      channel,
      body: draftReply,
      language: u.language,
    });
  }

  return {
    draftReply,
    recommendedNextAction:
      result.recommended_next_action || facts.recommendedNextAction,
    decisionRationale: result.decision_rationale || templateRationale(u, facts),
  };
}

function buildContext(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
  channel: Channel,
): string {
  const intake = u.extracted_intake;
  return [
    `Classification: ${u.classification}`,
    `Urgency: ${u.urgency}`,
    `Scenario: ${facts.scenario}`,
    `Child: ${intake.child_name ?? "unknown"}`,
    `Discipline: ${u.discipline?.join("/") ?? "unspecified"}`,
    `Language for reply: ${u.language}`,
    `Reply channel: ${channel}`,
    `Sender intent: ${u.intent}`,
    facts.insuranceStatus
      ? `Insurance verification: ${facts.insuranceStatus}${
          facts.insuranceNotes ? ` (${facts.insuranceNotes})` : ""
        }`
      : "Insurance verification: not performed",
    facts.missingInfo.length
      ? `Missing information: ${facts.missingInfo.join(", ")}`
      : "Missing information: none",
    facts.held && facts.earliestSlot
      ? `Pending hold: ${facts.earliestSlot.start} with ${facts.earliestSlot.provider_name} (NOT booked)`
      : `Pending hold: none`,
    `Existing patient record found: ${facts.patientFound ? "yes" : "no"}`,
    facts.escalation ? `Escalation: ${facts.escalation.severity}` : "Escalation: none",
    `Tasks created: ${facts.taskIds.length}`,
    `Deterministic recommended action (baseline): ${facts.recommendedNextAction}`,
    "",
    "Original message:",
    item.body,
  ].join("\n");
}

function pickChannel(item: InboxItem, u: Understanding): Channel {
  if (item.channel === "portal_message") return "portal";
  if (item.channel === "voicemail_transcript") return "phone";
  if (item.channel === "email") return "email";
  // fax_referral: prefer email if a parent email is on file, else phone.
  return /@/.test(u.extracted_intake.parent_contact ?? "") ? "email" : "phone";
}

function pickRecipient(item: InboxItem, u: Understanding): string {
  const contact = u.extracted_intake.parent_contact;
  if (contact) {
    const email = contact.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    if (email) return email[0];
    const phone = contact.match(/\d{3}-\d{4}/);
    if (phone) return phone[0];
    return contact;
  }
  return item.sender;
}

// ---- templated fallback (no LLM) -------------------------------------------

function templateCompose(
  u: Understanding,
  facts: OrchestrationFacts,
): LlmCompose {
  return {
    draft_reply: templateDraft(u, facts),
    recommended_next_action: facts.recommendedNextAction,
    decision_rationale: templateRationale(u, facts),
  };
}

function templateDraft(u: Understanding, facts: OrchestrationFacts): string | null {
  const name = u.extracted_intake.child_name ?? "your child";
  const es = u.language === "es";

  if (facts.scenario === "safeguarding") {
    return es
      ? "Hola, gracias por su mensaje. Lo hemos recibido y un miembro de nuestro equipo se comunicará con usted en breve."
      : "Hi, thank you for your message. We've received it and a member of our team will follow up with you shortly.";
  }
  if (facts.scenario === "spam") return null;

  if (u.classification === "clinical_question") {
    return `Hi, thanks for reaching out about ${name}. We're not able to give clinical advice by message, but we'd be glad to set up a screening or evaluation so a clinician can take a proper look. A team member will follow up to arrange the next step.`;
  }
  if (u.classification === "missing_paperwork") {
    return `Hi, thank you for the referral for ${name}. To move forward we need a few more details: ${facts.missingInfo.join(
      ", ",
    )}. A team member will reach out to collect these.`;
  }
  if (facts.insuranceStatus === "out_of_network" || facts.insuranceStatus === "expired") {
    return `Hi, thank you for ${name}'s referral. Our billing team needs to review the insurance on file before we move forward with scheduling, and will follow up with you about options.`;
  }
  if (facts.held && facts.earliestSlot) {
    return `Hi, thank you for ${name}'s referral. We've tentatively set aside an evaluation time and a team member will follow up to confirm it with you. Nothing is booked yet.`;
  }
  if (facts.scenario === "same_day_reschedule") {
    return `Hi, thanks for letting us know about ${name}. Our front desk will follow up shortly to help reschedule. Please reach out by phone if today's timing is urgent.`;
  }
  return `Hi, thank you for contacting Cedar Kids Therapy about ${name}. A team member will review your message and follow up with the next steps.`;
}

function templateRationale(u: Understanding, facts: OrchestrationFacts): string {
  const bits = [
    `Classified ${u.classification} at ${u.urgency}.`,
  ];
  if (facts.escalation) bits.push("Escalated per safeguarding policy.");
  if (facts.insuranceStatus)
    bits.push(`Insurance verified ${facts.insuranceStatus}.`);
  if (facts.held) bits.push("Placed a pending-review slot hold (not booked).");
  if (facts.missingInfo.length)
    bits.push(`Missing: ${facts.missingInfo.join(", ")}.`);
  return bits.join(" ");
}
