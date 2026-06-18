import type { Assignee, InboxItem, PolicyTopic, Slot } from "./types.js";
import type { OrchestrationFacts, Understanding } from "./triage-types.js";
import {
  create_task,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "./tools.js";

/**
 * Stage 2 — the action model. Pure, deterministic control flow that calls the
 * provided tools in dependency order, branching on the *live* tool results
 * (insurance status, slot availability, patient match) that the LLM cannot
 * predict. Every tool call here is intentional and surfaced in the audit trace;
 * nothing speculative is called.
 */
export async function orchestrate(
  item: InboxItem,
  u: Understanding,
): Promise<OrchestrationFacts> {
  const facts: OrchestrationFacts = {
    scenario: u.classification,
    taskIds: [],
    escalation: null,
    missingInfo: [],
    policyTopics: [],
    insuranceStatus: null,
    insuranceNotes: null,
    earliestSlot: null,
    slotCount: 0,
    held: false,
    patientFound: false,
    recommendedNextAction: "",
  };

  switch (u.classification) {
    case "safeguarding":
      return safeguarding(item, u, facts);
    case "clinical_question":
      return clinicalQuestion(item, u, facts);
    case "missing_paperwork":
      return missingPaperwork(item, u, facts);
    case "scheduling":
    case "existing_patient_request":
      return scheduling(item, u, facts);
    case "new_referral":
      return newReferral(item, u, facts);
    case "spam":
      facts.scenario = "spam";
      facts.recommendedNextAction =
        "No action required; mark as spam/FYI after a quick human glance.";
      return facts;
    default:
      return fallbackOther(item, u, facts);
  }
}

async function safeguarding(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  facts.scenario = "safeguarding";
  await recordPolicy(facts, "safeguarding");

  const reason = `Possible safeguarding concern in ${item.id}: ${u.intent}`;
  await escalate({ item_id: item.id, reason, severity: "P0" });
  facts.escalation = { reason, severity: "P0" };

  const task = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour safeguarding review: ${childLabel(u)}`,
    due: dueDate(item, "P0"),
    notes: `Escalated P0. ${u.intent} Do not provide investigative advice; clinical lead to review immediately per safeguarding policy.`,
  });
  facts.taskIds.push(task.data.task_id);

  facts.recommendedNextAction =
    "Clinical lead reviews this safeguarding disclosure within the hour; staff send only a neutral acknowledgement.";
  return facts;
}

async function clinicalQuestion(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  facts.scenario = "clinical_question";
  await recordPolicy(facts, "clinical_advice");

  const task = await create_task({
    assignee: "intake",
    title: `Route clinical question to screening: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: `Parent is asking for clinical advice (${u.intent}). Policy forbids advice by message; offer a screening/evaluation instead.`,
  });
  facts.taskIds.push(task.data.task_id);

  facts.recommendedNextAction =
    "Intake offers a screening or evaluation; do not answer the clinical question by message.";
  return facts;
}

async function missingPaperwork(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  facts.scenario = "missing_paperwork";
  facts.missingInfo = computeMissingInfo(u);

  const task = await create_task({
    assignee: "front_desk",
    title: `Obtain missing referral details: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: `Referral incomplete. Missing: ${
      facts.missingInfo.join(", ") || "see referral"
    }. Contact referring provider/family before intake can proceed.`,
  });
  facts.taskIds.push(task.data.task_id);

  facts.recommendedNextAction = `Front desk collects the missing fields (${facts.missingInfo.join(
    ", ",
  )}) before intake proceeds.`;
  return facts;
}

async function scheduling(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  facts.scenario = u.same_day_operational ? "same_day_reschedule" : "scheduling";

  facts.patientFound = await tryFindPatient(u);

  const urgency = u.same_day_operational ? "P1" : "P2";
  const task = await create_task({
    assignee: "front_desk",
    title: `${u.same_day_operational ? "Same-day " : ""}scheduling request: ${childLabel(u)}`,
    due: dueDate(item, urgency),
    notes: `${u.intent} ${
      facts.patientFound
        ? "Existing patient record located."
        : "No matching patient record found; verify identity."
    } Staff to action; agent does not book.`,
  });
  facts.taskIds.push(task.data.task_id);

  facts.recommendedNextAction = u.same_day_operational
    ? "Front desk handles the same-day reschedule promptly; agent does not book."
    : "Front desk follows up on the scheduling request; agent does not book.";
  return facts;
}

async function newReferral(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  facts.scenario = "new_referral";
  facts.missingInfo = computeMissingInfo(u);
  facts.patientFound = await tryFindPatient(u);

  const payer = u.extracted_intake.payer;
  if (!payer) {
    // Can't verify without a payer — route to intake to collect it.
    const task = await create_task({
      assignee: "intake",
      title: `Confirm insurance and intake details: ${childLabel(u)}`,
      due: dueDate(item, "P2"),
      notes: `New ${disciplineLabel(u)} referral with no payer on file. Collect insurance before verification and scheduling.`,
    });
    facts.taskIds.push(task.data.task_id);
    facts.recommendedNextAction =
      "Intake collects insurance details before verifying coverage and offering slots.";
    return facts;
  }

  const insurance = await verify_insurance({
    payer,
    member_id: u.extracted_intake.member_id ?? undefined,
  });
  facts.insuranceStatus = insurance.data.status;
  facts.insuranceNotes = insurance.data.notes ?? null;

  if (insurance.data.status === "in_network") {
    return inNetworkReferral(item, u, facts);
  }
  if (
    insurance.data.status === "out_of_network" ||
    insurance.data.status === "expired"
  ) {
    return benefitsReviewReferral(item, u, facts);
  }
  // unknown payer
  await recordPolicy(facts, "insurance");
  const task = await create_task({
    assignee: "intake",
    title: `Verify unrecognized insurance: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: `Payer "${payer}" was not recognized by billing. Confirm coverage manually before scheduling.`,
  });
  facts.taskIds.push(task.data.task_id);
  facts.recommendedNextAction =
    "Intake manually verifies the unrecognized payer before offering slots.";
  return facts;
}

async function inNetworkReferral(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  const complete = facts.missingInfo.length === 0;

  const discipline = u.discipline?.[0];
  const slots = await find_slots({
    discipline,
    language: u.language,
    preferences: u.preferences ?? undefined,
  });
  facts.slotCount = slots.data.length;
  facts.earliestSlot = slots.data[0] ?? null;

  // Hold a slot only on the clean path: in-network, complete intake, a slot
  // matching the requested discipline. But if the family stated a specific
  // time/day preference, do NOT presume a hold (the earliest slot likely
  // conflicts) — recommend instead and let staff offer a matching time. A
  // language preference is already satisfied by provider matching, so it does
  // not block a hold.
  const slot = facts.earliestSlot;
  const timePref = hasTimePreference(u);
  const disciplineMatches = slot && (!discipline || slot.discipline === discipline);
  if (complete && slot && disciplineMatches && !timePref) {
    await hold_slot({ slot_id: slot.slot_id, patient_ref: childLabel(u) });
    facts.held = true;
  }

  const task = await create_task({
    assignee: "intake",
    title: `${facts.held ? "Confirm held slot" : "Schedule evaluation"}: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: buildReferralTaskNotes(u, facts),
  });
  facts.taskIds.push(task.data.task_id);

  if (facts.held) {
    facts.recommendedNextAction = `Intake confirms the pending hold with ${slot?.provider_name} and books the evaluation.`;
  } else if (timePref && slot) {
    facts.recommendedNextAction = `Intake offers a time matching the family's stated preference (${u.preferences}) — earliest availability is ${slot.start} with ${slot.provider_name} — then confirms and books.`;
  } else {
    facts.recommendedNextAction = missingOrNoSlotAction(facts);
  }
  return facts;
}

async function benefitsReviewReferral(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  await recordPolicy(facts, "insurance");
  const expired = facts.insuranceStatus === "expired";

  const task = await create_task({
    assignee: "billing",
    title: `${expired ? "Resolve expired coverage" : "Discuss out-of-network benefits"}: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: `${u.extracted_intake.payer} verified ${facts.insuranceStatus} for ${childLabel(
      u,
    )}. ${
      expired
        ? "Billing shows coverage expired; referral document may be stale — confirm current coverage before any scheduling."
        : "Hold a benefits conversation before any slot is held or scheduled."
    }`,
  });
  facts.taskIds.push(task.data.task_id);

  facts.recommendedNextAction = expired
    ? "Billing confirms current coverage (system shows expired) before any scheduling step."
    : "Billing reviews out-of-network options with the family before any slot is held.";
  return facts;
}

async function fallbackOther(
  item: InboxItem,
  u: Understanding,
  facts: OrchestrationFacts,
): Promise<OrchestrationFacts> {
  const task = await create_task({
    assignee: "front_desk",
    title: `Review inbox item: ${childLabel(u)}`,
    due: dueDate(item, "P2"),
    notes: `${u.intent} Needs a human to determine the right workflow.`,
  });
  facts.taskIds.push(task.data.task_id);
  facts.recommendedNextAction = "Front desk reviews and routes this item.";
  return facts;
}

// ---- helpers ----------------------------------------------------------------

async function recordPolicy(
  facts: OrchestrationFacts,
  topic: PolicyTopic,
): Promise<void> {
  await lookup_policy({ topic });
  facts.policyTopics.push(topic);
}

async function tryFindPatient(u: Understanding): Promise<boolean> {
  const name = u.extracted_intake.child_name;
  if (!name) return false;
  const dob = isIsoDate(u.extracted_intake.dob_or_age)
    ? (u.extracted_intake.dob_or_age as string)
    : undefined;
  const result = await search_patient({ name, dob });
  return result.data.length > 0;
}

function computeMissingInfo(u: Understanding): string[] {
  const intake = u.extracted_intake;
  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth");
  if (!intake.parent_contact) missing.push("guardian contact");
  if (!intake.discipline || intake.discipline.length === 0)
    missing.push("requested discipline");
  if (!intake.payer) missing.push("insurance");
  return missing;
}

function buildReferralTaskNotes(
  u: Understanding,
  facts: OrchestrationFacts,
): string {
  const parts = [`In-network ${disciplineLabel(u)} referral for ${childLabel(u)}.`];
  if (facts.held && facts.earliestSlot) {
    parts.push(
      `Pending-review hold placed for ${facts.earliestSlot.start} with ${facts.earliestSlot.provider_name}; confirm with family.`,
    );
  } else if (facts.missingInfo.length) {
    parts.push(`Collect missing info first: ${facts.missingInfo.join(", ")}.`);
  } else if (hasTimePreference(u) && facts.earliestSlot) {
    parts.push(
      `Family stated a time preference (${u.preferences}); offer a matching slot rather than auto-holding. Earliest available: ${facts.earliestSlot.start} with ${facts.earliestSlot.provider_name}.`,
    );
  } else if (facts.slotCount === 0) {
    parts.push("No matching provider slot available; review capacity.");
  }
  if (facts.patientFound) parts.push("Existing patient record found — dedupe.");
  return parts.join(" ");
}

function missingOrNoSlotAction(facts: OrchestrationFacts): string {
  if (facts.missingInfo.length) {
    return `Intake collects missing info (${facts.missingInfo.join(
      ", ",
    )}) before holding a slot.`;
  }
  if (facts.slotCount === 0) {
    return "Intake reviews provider capacity — no matching slot is currently available.";
  }
  return "Intake reviews available slots with the family.";
}

/** True when the family stated a specific day/time scheduling preference (which
 * should be reconciled by staff), as opposed to a provider/language preference
 * (already satisfied by matching). */
function hasTimePreference(u: Understanding): boolean {
  const p = (u.preferences ?? "").toLowerCase();
  if (!p) return false;
  return /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|after[ -]school|weekday|weekend|early|late)\b|\b\d{1,2}\s*(?:am|pm)\b|\b(?:am|pm)\b/.test(
    p,
  );
}

function childLabel(u: Understanding): string {
  return u.extracted_intake.child_name ?? "the child";
}

function disciplineLabel(u: Understanding): string {
  return u.discipline?.join("/") ?? "therapy";
}

function isIsoDate(value: string | null): boolean {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}

/** Due date derived from the item's own timestamp (not wall-clock), so output
 * is deterministic and contextually sensible relative to the referral. */
function dueDate(item: InboxItem, urgency: "P0" | "P1" | "P2"): string {
  const base = new Date(item.received_at);
  const addDays = urgency === "P2" ? 2 : 0;
  base.setUTCDate(base.getUTCDate() + addDays);
  return base.toISOString().slice(0, 10);
}

export type { Slot };
