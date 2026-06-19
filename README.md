# Cedar Kids Therapy — Referral Inbox Triage Agent

An AI agent prototype that turns a messy Monday inbox (fax referrals, parent
voicemails, portal messages, emails) into a sorted, human-reviewable action
plan — one audited `ItemOutput` per inbox item.

The guiding principle is **the LLM understands; deterministic code acts.** The
model reads each message and produces a structured judgement (classification,
urgency, extracted intake, safety flag, language); deterministic code then
decides which tools to call and in what order, branching on the live tool
results. This keeps every tool call intentional and audit-clean, and lets the
whole system degrade to a pure rule-based path when no API key is present.

---

## 1. How to run

```bash
npm install

# Optional: enable the LLM path (Anthropic). Without it, the agent runs fully
# rule-based and still passes validation.
export ANTHROPIC_API_KEY=sk-ant-...

npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
```

Both commands also work with no flags (they default to the paths above). Paths
are never hardcoded — reviewers can point `--input` at hidden synthetic data.
`npm run typecheck` runs the TypeScript compiler with no emit.

End-to-end runtime is a few minutes or less (two LLM calls per item, run with
bounded concurrency).

---

## 2. Stack and runtime

- **Language / runtime:** TypeScript on Node LTS, run via `tsx`. npm only.
- **Provider:** Anthropic SDK (`@anthropic-ai/sdk`), model `claude-sonnet-4-6`,
  adaptive thinking, structured outputs (`output_config.format` / JSON schema)
  for the understanding and compose stages. The large, stable system prompts are
  cached (`cache_control: ephemeral`) so per-item calls reuse the prefix.
- **Key handling:** read from `ANTHROPIC_API_KEY` only; never written to disk or
  committed. Used solely against the synthetic data here.
- **No-key mode:** if `ANTHROPIC_API_KEY` is unset (or any LLM call fails), the
  agent falls back to a complete rule engine and still produces valid output.

---

## 3. Architecture

A three-stage pipeline runs per item, inside that item's audit context
(`withItemContext(item.id, …)`), with bounded concurrency (≈5 items at once).

![Triage agent architecture — per-item three-stage pipeline](docs/architecture.png)

<sub>Diagram source: [`docs/architecture.mmd`](docs/architecture.mmd) (Mermaid).</sub>

Every item also carries a `decision_rationale` — the agent's reasoning trail —
explaining the classification, the urgency, why those tools were chosen, and the
governing policy, citing the actual tool results (e.g. "Kaiser HMO confirmed
out-of-network, which per policy triggers a benefits conversation before
scheduling"). That field is the human-readable "thinking process" behind each
decision and the core of the audit story.

| Stage / file | Responsibility |
|---|---|
| `understand.ts` | **Stage 1.** LLM returns structured judgement; run in parallel with `rules.extractIntake` and reconciled (regex wins on labeled fax/email fields, LLM wins on natural-language fields and judgement). |
| `safety.ts` | **Dual-path safety gate.** Forces `safeguarding`/P0 if *either* the LLM flag *or* a deterministic keyword net fires (recall over precision — a human reviews every flag). Also enforces anti-over-escalation: a P1 with no genuine same-day signal is pulled back to the P2 default. |
| `orchestrate.ts` | **Stage 2.** Pure, deterministic control flow. The *only* place tools are called. Branches on live tool results (insurance status, slot availability, patient match). |
| `compose.ts` | **Stage 3.** LLM writes `draft_reply` (en/es), `recommended_next_action`, `decision_rationale` conditioned on the real tool results, then calls `draft_message`. No clinical advice; never implies a message was sent or an appointment booked. |
| `rules.ts` | Regex/heuristic extraction, classification, safeguarding keyword net — both the precision layer for labeled fields and the full no-LLM fallback. |
| `llm.ts` | The single Anthropic integration point: client, prompt caching, structured/text helpers, retry, graceful degradation. |
| `agent.ts` | Wires the stages, owns concurrency and per-item fault isolation. |
| `triage-types.ts` | Internal contracts shared across stages (kept separate from the graded `types.ts`). |

**Why the LLM never calls tools directly.** The validator does exact trace
matching: every non-exempt tool call must surface in the output exactly once,
and "performative" calls are penalized. An LLM driving its own tool loop would
make that hard to keep clean and easy to over-call. Putting orchestration in
deterministic code makes audit-correctness a property of the structure, not of
vigilance.

**Tool-orchestration policy (Stage 2 decision table).**

| Situation | Tools fired | Notes |
|---|---|---|
| Safeguarding (either detector) | `lookup_policy` · `escalate(P0)` · `create_task(clinical_lead)` | Neutral acknowledgement draft only |
| New referral, in-network, **no prior auth**, complete intake, no time preference | `search_patient` · `verify_insurance` · `find_slots` · `hold_slot` · `create_task` | The only path that holds a slot (pending review, never booked) |
| In-network but **prior authorization required** | `search_patient` · `verify_insurance` · `lookup_policy` · `create_task(billing)` | **Pause:** no slot lookup or hold; obtain authorization first; draft says benefits/auth verified before scheduling |
| Out-of-network / expired insurance | `verify_insurance` · `lookup_policy` · `create_task(billing)` | No hold; benefits conversation first |
| Unknown payer | `verify_insurance` · `lookup_policy` · `create_task(intake)` | Manual verification before slots |
| In-network, no auth, but stated time preference or incomplete intake | `verify_insurance` · `find_slots` · `create_task` | Hold withheld; staff offers a matching time / collects missing fields |
| Clinical question | `lookup_policy` · `create_task(intake)` | Route to screening/eval; give no advice |
| Missing paperwork | `create_task(front_desk)` | `missing_info[]` populated; draft requests the blanks |
| Same-day reschedule | `search_patient` · `create_task(front_desk)` | P1; existing patient |
| Patient record concern (inactive, or requester ≠ guardian on file) | `search_patient` · `create_task(front_desk: verify)` | **Pause:** verify authorization first; no hold; draft reveals no record details |
| Spanish anywhere | `find_slots(language:'es')` + Spanish draft | Matches a Spanish-capable provider |

All eight tools are exercised across the visible batch; `hold_slot` and
`escalate` (the strongest actions) fire only on the clean and the safeguarding
paths respectively.

**Evidence must establish what the action assumes.** A tool result that *looks*
like a green light isn't necessarily one. `verify_insurance` returning
`in_network` confirms coverage but **not** that the service is authorized — the
same result carries `auth_required`. So `in_network` alone never proceeds to a
hold: if `auth_required` is true the system pauses, routes to billing for prior
authorization, and the family-facing draft says benefits/authorization will be
verified *before* scheduling (it never implies a time is set). A slot is held
only when coverage is in-network **and** authorization is not required **and**
intake is complete **and** the family stated no conflicting time preference.

The same rigor applies to `search_patient`: a match establishes that a record
*exists* — not that the patient is *active* or that the person contacting us is
the *authorized guardian*. So a match never silently proceeds. If the record is
inactive, or the requester's name doesn't match the guardian on file (e.g.
item_4: "Carla Mendez" contacting about a record whose guardian is "Sofia
Ramirez"), the system pauses: it files a front-desk authorization-verification
task as the leading step, withholds any slot hold, and the family draft becomes
a neutral acknowledgement that reveals nothing about the record (no coverage,
referral, or appointment details, no other guardian's name) — protecting against
disclosing a child's information to a possibly-unauthorized requester. The
surname check avoids false alarms on legitimate co-parents, and clinic-originated
fax referrals are exempt (no guardian claim to reconcile).

---

## 4. Failure modes and production eval

**Known failure modes**

- **LLM nondeterminism.** Even at low variance, classification can toggle between
  two equally-valid labels (observed: item_8 `existing_patient_request` ↔
  `scheduling`, identical urgency/tools/behavior). The committed `output.json`
  may therefore differ slightly on regeneration. Urgency, safety, and tool
  decisions have been stable across runs.
- **Extraction on free-text channels.** Voicemails/portal messages have no
  labeled fields; the rule layer is best-effort there and leans on the LLM. A
  wrong name/DOB would mostly surface as a failed `search_patient` (caught) but
  could mis-route.
- **Safeguarding recall vs precision.** The keyword net is deliberately broad, so
  false positives are possible (a human reviews them). A novel phrasing the net
  misses would still need the LLM flag to catch it — the OR gate is the mitigation,
  not a guarantee.
- **Over-escalation.** Guarded by coupling P1 to a genuine same-day signal, but a
  truly novel "imminent harm, non-abuse" case relies on the LLM's P0 judgement.

**How I'd evaluate this in production**

- A **labeled gold set** of inbox items (expanded well beyond these 8, covering
  every channel, payer status, language, and the safety edge cases) scored on:
  classification accuracy, urgency calibration (with a specific eye on the P0/P1
  false-positive rate, since over-escalation is a real cost), and extraction F1.
- **Safety as a separate, weighted metric.** Track safeguarding recall as the
  primary safety SLO (missing one is catastrophic) and precision as a secondary
  cost metric; alert on regressions.
- **Tool-trace assertions** in CI (the validator is the seed): right tools for the
  scenario, no `hold_slot` on out-of-network, no forbidden actions.
- **LLM-as-judge** on draft quality (empathetic, no clinical advice, never implies
  sent), plus a hard regex/style gate for the "never implies sent/booked" rule.
- **Human-in-the-loop telemetry:** since every item is review-required, log
  reviewer overrides and feed disagreements back as new eval cases.

---

## 5. What I chose not to build, and why

- **An LLM-driven tool-use loop.** Deliberately avoided — see Architecture. The
  audit/trace contract and the anti-performative-call rule make deterministic
  orchestration both safer and higher-scoring.
- **Provider age-range / capacity matching beyond what `find_slots` returns.** I
  surface "no matching slot" and route to capacity review, but don't try to
  reason about `age_range` fit — out of scope for the time and low value vs. risk.
- **A retry/repair loop on malformed LLM JSON.** Structured outputs make this rare;
  I retry once on transient errors and otherwise fall back to rules rather than
  building a parser-repair stage.
- **Persisting or de-duplicating across runs.** Each batch is independent;
  cross-batch patient dedup would need real state.
- **A test framework.** I validated by running the real pipeline (LLM and no-key)
  and a synthetic hidden-variant inbox; I did not add a unit-test harness under
  the time box (see below).

---

## 6. What I would do with another 4 hours

- Add a **unit-test suite** (Vitest) over `rules.ts` extraction, the safety gate,
  and each orchestration branch, plus a fixture-based eval harness with the gold
  set and trace assertions described in §4.
- **Prompt-cache pre-warming** and a token/latency budget readout, and measure
  cache hit rate explicitly.
- A small **draft-quality linter** (deterministic checks for "implies sent",
  clinical-advice phrasing, language match) as a guardrail independent of the LLM.
- Richer **provider matching** (age range, caseload, language preference ranking)
  and a "no Spanish-capable provider available" explicit path.
- An **eval CLI** that diffs a run against the gold set and reports per-dimension
  scores, so regressions are visible before review.

---

## Notes for reviewers

- Provided files (`tools.ts`, `index.ts`, `validate.ts`, `types.ts`, schema,
  data) are unmodified. New code lives in `src/{agent,understand,safety,orchestrate,compose,rules,llm,triage-types}.ts`.
- `tools_called` is taken verbatim from `getToolCallsForItem(item.id)`; summary
  counts come from the starter's `buildBatchOutput`.
- The committed `output.json` was generated with the LLM path enabled.
