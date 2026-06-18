import type { Discipline, InboxItem } from "./types.js";
import type { Understanding } from "./triage-types.js";
import { callStructured, isLLMEnabled } from "./llm.js";
import { extractIntake, ruleUnderstanding } from "./rules.js";

/**
 * Stage 1 — turn a messy inbox item into a structured `Understanding`.
 *
 * The LLM owns judgement (classification, urgency, safety, language, intent and
 * the unstructured fields); the rule engine owns precision on the labeled
 * fax/email fields. We run both and reconcile, playing each to its strength.
 * With no API key, the pure rule understanding is returned.
 */

interface LlmUnderstanding {
  classification: Understanding["classification"];
  urgency: Understanding["urgency"];
  child_name: string | null;
  dob_or_age: string | null;
  parent_contact: string | null;
  discipline: Discipline[] | null;
  diagnosis_or_concern: string | null;
  payer: string | null;
  member_id: string | null;
  language: "en" | "es";
  preferences: string | null;
  safety_flag: boolean;
  same_day_operational: boolean;
  intent: string;
}

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "classification",
    "urgency",
    "child_name",
    "dob_or_age",
    "parent_contact",
    "discipline",
    "diagnosis_or_concern",
    "payer",
    "member_id",
    "language",
    "preferences",
    "safety_flag",
    "same_day_operational",
    "intent",
  ],
  properties: {
    classification: {
      type: "string",
      enum: [
        "new_referral",
        "existing_patient_request",
        "scheduling",
        "clinical_question",
        "billing_question",
        "missing_paperwork",
        "provider_followup",
        "complaint",
        "safeguarding",
        "spam",
        "other",
      ],
    },
    urgency: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    child_name: { type: ["string", "null"] },
    dob_or_age: { type: ["string", "null"] },
    parent_contact: { type: ["string", "null"] },
    discipline: {
      type: ["array", "null"],
      items: { type: "string", enum: ["SLP", "OT", "PT"] },
    },
    diagnosis_or_concern: { type: ["string", "null"] },
    payer: { type: ["string", "null"] },
    member_id: { type: ["string", "null"] },
    language: { type: "string", enum: ["en", "es"] },
    preferences: { type: ["string", "null"] },
    safety_flag: { type: "boolean" },
    same_day_operational: { type: "boolean" },
    intent: { type: "string" },
  },
};

const SYSTEM = `You are the triage intelligence for Cedar Kids Therapy, a multi-disciplinary pediatric therapy practice (speech-language pathology [SLP], occupational therapy [OT], physical therapy [PT]) serving children ages 0-18. You read one inbox item at a time and return a single structured judgement. You do not take actions or talk to families — downstream deterministic code does that. Your only job is to understand the message accurately.

## Practice policies (authoritative)
- Service lines: SLP, OT, PT for ages 0-18. Intake confirms the requested discipline before scheduling.
- Insurance — in-network: Aetna, Blue Cross Blue Shield, UnitedHealthcare, Medicaid. Out-of-network: Kaiser, Cigna Select, Beacon. Out-of-network requires a benefits conversation before any slot. Verified billing status supersedes the payer named on a referral; surface conflicts.
- Safeguarding: any message suggesting harm, abuse, neglect, or unsafe caregiving is P0 — escalate to the clinical lead immediately. Never give investigative advice.
- Clinical advice: front desk and automated systems must NOT give clinical advice. Route clinical questions to screening/evaluation/clinician review.
- Scheduling: same-day cancellations or reschedules are P1. Agents may find or hold slots for human review but must never book.
- Language access: families may request Spanish; respond in the family's preferred language.

## Urgency calibration (read carefully)
- P0: safeguarding, imminent harm, mandated-reporter escalation. Same-hour human review.
- P1: a same-day operational issue requiring prompt staff action (e.g. a same-day reschedule or cancellation).
- P2: normal intake, scheduling, billing, or clinical-review workflow. THIS IS THE DEFAULT.
- P3: low-priority admin, FYI, spam.
Default to P2 unless there is a clear safety reason (P0) or a genuine same-day operational need (P1). Over-escalation is itself a failure: loud wording ("URGENT", "ASAP", "!!!") is NOT a reason to raise priority. Set same_day_operational=true if and only if you assign P1.

## Classification guide
- new_referral: a new patient referral (fax, email, or call) requesting an evaluation.
- existing_patient_request / scheduling: requests about an existing appointment, including same-day reschedules/cancellations.
- clinical_question: a parent asking for clinical advice or reassurance. They are NOT yet booking.
- missing_paperwork: a referral missing required fields (DOB, guardian, insurance, etc.).
- billing_question, provider_followup, complaint, spam, other: as named.
- safeguarding: any harm/abuse/neglect/unsafe-caregiving disclosure (even if buried inside an otherwise routine request).

## Safety
Set safety_flag=true if the message contains ANY hint of harm, abuse, neglect, or unsafe caregiving toward the child — even a single phrase inside an otherwise ordinary request. When in doubt, flag it.

## Extraction
Extract child_name, dob_or_age (a date OR an age like "6 years old"), parent_contact (name/phone/email as given), discipline (array of SLP/OT/PT), diagnosis_or_concern, payer (insurance plan as written), member_id. Use null for anything truly absent. Detect language (en/es). Capture scheduling preferences in 'preferences'. 'intent' is a one-line plain-English summary of what the sender wants.

Return only the structured object.`;

export async function understand(item: InboxItem): Promise<Understanding> {
  const ruleIntake = extractIntake(item);

  if (!isLLMEnabled()) {
    return ruleUnderstanding(item);
  }

  try {
    const llm = await callStructured<LlmUnderstanding>({
      system: SYSTEM,
      user: formatItem(item),
      schema: SCHEMA,
      maxTokens: 1500,
    });

    // Reconcile: rules win on exact labeled fields; LLM wins on natural-language
    // fields and on judgement (classification/urgency/safety/language).
    return {
      classification: llm.classification,
      urgency: llm.urgency,
      extracted_intake: {
        child_name: llm.child_name ?? ruleIntake.child_name,
        dob_or_age: ruleIntake.dob_or_age ?? llm.dob_or_age,
        parent_contact: ruleIntake.parent_contact ?? llm.parent_contact,
        discipline: ruleIntake.discipline ?? llm.discipline,
        diagnosis_or_concern:
          llm.diagnosis_or_concern ?? ruleIntake.diagnosis_or_concern,
        payer: ruleIntake.payer ?? llm.payer,
        member_id: ruleIntake.member_id ?? llm.member_id,
      },
      discipline: ruleIntake.discipline ?? llm.discipline,
      language: llm.language,
      preferences: llm.preferences,
      safety_flag: llm.safety_flag,
      intent: llm.intent,
      same_day_operational: llm.same_day_operational,
      source: "llm",
    };
  } catch (error) {
    // Never fail an item — fall back to the deterministic understanding.
    console.error(
      `understand(${item.id}) fell back to rules: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return ruleUnderstanding(item);
  }
}

function formatItem(item: InboxItem): string {
  return [
    `Channel: ${item.channel}`,
    `Received: ${item.received_at}`,
    `Sender: ${item.sender}`,
    `Subject: ${item.subject}`,
    `Body: ${item.body}`,
    item.attachments.length
      ? `Attachments: ${item.attachments.join(", ")}`
      : "Attachments: none",
  ].join("\n");
}
