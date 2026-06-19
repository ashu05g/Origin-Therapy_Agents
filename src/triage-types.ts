import type {
  Classification,
  Discipline,
  ExtractedIntake,
  PolicyTopic,
  Slot,
  Urgency,
} from "./types.js";

/**
 * Internal contract shared across the triage stages. This is deliberately kept
 * separate from the graded output shape in `types.ts`: `Understanding` is what
 * Stage 1 (understand) produces and Stage 2/3 consume, not what we emit.
 */
export interface Understanding {
  classification: Classification;
  /** Provisional priority. The safety gate is the authority that can raise to
   * P0 or strip a tone-only P0/P1. */
  urgency: Urgency;
  extracted_intake: ExtractedIntake;
  /** Disciplines requested, if any could be determined. */
  discipline: Discipline[] | null;
  /** Preferred communication language. */
  language: "en" | "es";
  /** Free-text availability / scheduling preference, if stated. */
  preferences: string | null;
  /** True when the LLM judges a possible safeguarding concern. */
  safety_flag: boolean;
  /** One-line summary of what the sender wants. */
  intent: string;
  /** Whether the same-day operational signal is genuine (drives P1). */
  same_day_operational: boolean;
  /** Where the understanding came from, for the README/audit story. */
  source: "llm" | "rules";
}

type InsuranceStatus = "in_network" | "out_of_network" | "expired" | "unknown";

/**
 * Facts produced by Stage 2 orchestration: the tasks/escalations created, plus
 * the tool-derived context Stage 3 needs to write an accurate, situation-aware
 * draft. Orchestration is fully deterministic — no LLM here.
 */
export interface OrchestrationFacts {
  scenario: string;
  taskIds: string[];
  escalation: { reason: string; severity: "P0" | "P1" } | null;
  missingInfo: string[];
  policyTopics: PolicyTopic[];
  insuranceStatus: InsuranceStatus | null;
  insuranceNotes: string | null;
  /** From verify_insurance: in-network coverage still requires prior
   * authorization before scheduling. `in_network` status alone does NOT
   * establish the service is authorized. */
  authRequired: boolean | null;
  earliestSlot: Slot | null;
  slotCount: number;
  held: boolean;
  patientFound: boolean;
  /** Status of the matched patient record, if any. A match establishes a record
   * exists — not that it is usable. */
  patientStatus: "active" | "inactive" | null;
  /** Set when the search_patient result undermines an assumption the downstream
   * action would make: an inactive record, or a requester whose name does not
   * match the guardian on file. Drives a pause-and-verify step rather than
   * proceeding. */
  identityConcern: string | null;
  /** Deterministic baseline used directly in the no-LLM path and as a hint to
   * the composer. */
  recommendedNextAction: string;
}

/** What Stage 3 composition produces (LLM or templated fallback). */
export interface ComposeResult {
  draftReply: string | null;
  recommendedNextAction: string;
  decisionRationale: string;
}
