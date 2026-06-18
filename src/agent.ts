import type { InboxItem, ItemOutput } from "./types.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import { ruleUnderstanding } from "./rules.js";
import { understand } from "./understand.js";
import { applySafetyGate } from "./safety.js";
import { orchestrate } from "./orchestrate.js";
import { compose } from "./compose.js";

/**
 * Entry point. For each inbox item we run the three-stage pipeline
 * (understand → orchestrate → compose) inside its own audit context, with
 * bounded concurrency. Every tool call happens inside `withItemContext`, and
 * `tools_called` is taken verbatim from the trace via `getToolCallsForItem`.
 *
 * Each item is isolated: a failure produces a thin-but-valid output rather than
 * sinking the batch, and still surfaces any tool calls already recorded.
 */

const CONCURRENCY = 5;

export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  return mapWithConcurrency(inbox, CONCURRENCY, triageItem);
}

async function triageItem(item: InboxItem): Promise<ItemOutput> {
  return withItemContext(item.id, async () => {
    try {
      const understanding = applySafetyGate(await understand(item), item);
      const facts = await orchestrate(item, understanding);
      const composed = await compose(item, understanding, facts);

      return {
        item_id: item.id,
        classification: understanding.classification,
        urgency: understanding.urgency,
        requires_human_review: true,
        extracted_intake: understanding.extracted_intake,
        missing_info: facts.missingInfo,
        tools_called: getToolCallsForItem(item.id),
        recommended_next_action: composed.recommendedNextAction,
        draft_reply: composed.draftReply,
        task_ids: facts.taskIds,
        escalation: facts.escalation,
        decision_rationale: composed.decisionRationale,
      };
    } catch (error) {
      return fallbackOutput(item, error);
    }
  });
}

/** Deterministic, always-valid output when the pipeline errors mid-item. */
function fallbackOutput(item: InboxItem, error: unknown): ItemOutput {
  const understanding = applySafetyGate(ruleUnderstanding(item), item);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`triageItem(${item.id}) error, emitting fallback: ${message}`);

  return {
    item_id: item.id,
    classification: understanding.classification,
    urgency: understanding.urgency,
    requires_human_review: true,
    extracted_intake: understanding.extracted_intake,
    missing_info: [],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action:
      "Manual review required — automated triage hit an error on this item.",
    draft_reply: null,
    task_ids: [],
    escalation:
      understanding.classification === "safeguarding"
        ? {
            reason: `Possible safeguarding concern in ${item.id}; flagged by fallback.`,
            severity: "P0",
          }
        : null,
    decision_rationale: `Automated triage error (${message}); fell back to rule-based classification. Human review required.`,
  };
}

/** Bounded-concurrency, order-preserving map. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    worker,
  );
  await Promise.all(workers);
  return results;
}
