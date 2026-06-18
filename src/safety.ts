import type { InboxItem } from "./types.js";
import type { Understanding } from "./triage-types.js";
import { detectSafeguarding } from "./rules.js";

/**
 * Deterministic backstop over the LLM's judgement. Two asymmetric jobs:
 *
 *  1. Catch safeguarding via an OR of two independent detectors (LLM flag and a
 *     keyword net). Missing an abuse disclosure is catastrophic; a false
 *     positive just means a human glances at a flagged item — so we bias toward
 *     escalation.
 *  2. Prevent over-escalation, which the brief calls out as its own failure
 *     mode. P1 is *defined* as a same-day operational issue, so a P1 with no
 *     same-day signal (e.g. a message that is merely loud — "URGENT!!!") is
 *     pulled back to the P2 default.
 */
export function applySafetyGate(
  understanding: Understanding,
  item: InboxItem,
): Understanding {
  const rulesSafeguarding = detectSafeguarding(item);

  if (understanding.safety_flag || rulesSafeguarding) {
    return {
      ...understanding,
      classification: "safeguarding",
      urgency: "P0",
      safety_flag: true,
    };
  }

  // Anti-over-escalation: P1 requires a genuine same-day operational reason.
  if (understanding.urgency === "P1" && !understanding.same_day_operational) {
    return { ...understanding, urgency: "P2" };
  }

  return understanding;
}
