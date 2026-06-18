import type {
  Classification,
  Discipline,
  ExtractedIntake,
  InboxItem,
  Urgency,
} from "./types.js";
import type { Understanding } from "./triage-types.js";

/**
 * Deterministic rule engine. It is both (a) the precision layer that extracts
 * the structured fax/email fields the LLM should not have to guess, and (b) the
 * full fallback that produces a valid understanding when no LLM is available.
 *
 * The labeled-field parser is intentionally precise; the unlabeled heuristics
 * (voicemails, free text) are best-effort because the LLM is the primary path
 * for those messages.
 */

// Labels seen in the synthetic fax/email referrals. Longer variants first so
// the alternation matches "discipline requested" before "discipline".
const FIELD_LABELS = [
  "parent/guardian",
  "discipline requested",
  "diagnosis/concern",
  "preferred availability",
  "member id",
  "child",
  "dob",
  "parent",
  "guardian",
  "discipline",
  "diagnosis",
  "concern",
  "insurance",
  "preferred",
  "family",
];

const LABEL_RE = new RegExp(`\\b(${FIELD_LABELS.join("|")})\\s*:`, "gi");

function isBlank(value: string | undefined | null): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase().replace(/[[\]]/g, "");
  return v === "" || v === "blank" || v === "n/a" || v === "unknown";
}

function clean(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim().replace(/[.;,]+$/, "").trim();
  return isBlank(trimmed) ? null : trimmed;
}

/** Tokenize "Label: value" pairs, each value running to the next known label. */
function parseLabeledFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const matches = [...body.matchAll(LABEL_RE)];
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const label = match[1].toLowerCase();
    const valueStart = match.index! + match[0].length;
    const valueEnd =
      i + 1 < matches.length ? matches[i + 1].index! : body.length;
    out[label] = body.slice(valueStart, valueEnd).trim();
  }
  return out;
}

const PHONE_RE = /\b\d{3}-\d{4}\b/;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/;
const DATE_RE = /\b(\d{4}-\d{2}-\d{2})\b/;
const MEMBER_RE = /\b([A-Z]{2,4}-\d{3,})\b/;
const AGE_RE =
  /\b(?:is|edad|tiene|age[d]?)\s+(\d{1,2})\b|\b(\d{1,2})[ -](?:year|años|anos)/i;

const KNOWN_PAYERS = [
  "blue cross blue shield",
  "blue cross",
  "bluecross",
  "bcbs",
  "aetna",
  "unitedhealthcare",
  "united healthcare",
  "united",
  "uhc",
  "medicaid",
  "kaiser",
  "cigna select",
  "cigna",
  "beacon",
  "sunrise",
  "pediatric choice",
  "community first",
];

function findPayer(body: string): string | null {
  const lower = body.toLowerCase();
  for (const payer of KNOWN_PAYERS) {
    const idx = lower.indexOf(payer);
    if (idx !== -1) {
      // Original-cased payer name plus a trailing plan word (PPO/HMO) if present.
      const base = body.slice(idx, idx + payer.length);
      const after = body.slice(idx + payer.length).match(/^\s+(PPO|HMO|EPO|POS)\b/i);
      return (after ? base + after[0] : base).trim();
    }
  }
  return null;
}

function extractMemberId(value: string | undefined): string | null {
  if (!value) return null;
  const m = value.match(MEMBER_RE);
  return m ? m[1] : null;
}

export function detectLanguage(body: string): "en" | "es" {
  const markers = [
    "hola",
    "soy ",
    "mi hija",
    "mi hijo",
    "gracias",
    "necesita",
    "evaluaci",
    "español",
    "espanol",
    "habla espa",
    "buenos d",
    "señor",
    "teléfono",
    "telefono",
  ];
  const lower = body.toLowerCase();
  return markers.some((m) => lower.includes(m)) ? "es" : "en";
}

export function detectDisciplines(body: string): Discipline[] | null {
  const lower = body.toLowerCase();
  const found = new Set<Discipline>();
  if (/\bslp\b|speech|articulation|language|habla|intelligib/.test(lower)) {
    found.add("SLP");
  }
  if (/\bot\b|occupational|sensory|feeding|fine motor/.test(lower)) {
    found.add("OT");
  }
  if (/\bpt\b|physical therapy|gross motor|toe walking|gait|tripping/.test(lower)) {
    found.add("PT");
  }
  return found.size ? [...found] : null;
}

export function extractIntake(item: InboxItem): ExtractedIntake {
  const body = item.body;
  const fields = parseLabeledFields(body);

  const childName =
    clean(fields["child"]) ?? unlabeledName(body);

  const dobLabeled = clean(fields["dob"]);
  const dobMatch = body.match(DATE_RE);
  const ageMatch = body.match(AGE_RE);
  const dobOrAge =
    dobLabeled ??
    (dobMatch ? dobMatch[1] : null) ??
    (ageMatch ? `${ageMatch[1] ?? ageMatch[2]} years old` : null);

  const parentContact =
    clean(fields["parent"] ?? fields["parent/guardian"] ?? fields["guardian"]) ??
    unlabeledContact(body);

  const disciplineRaw = fields["discipline requested"] ?? fields["discipline"];
  const discipline = disciplineRaw
    ? detectDisciplines(disciplineRaw) ?? detectDisciplines(body)
    : detectDisciplines(body);

  const concern =
    clean(fields["concern"] ?? fields["diagnosis/concern"] ?? fields["diagnosis"]);

  const payer = clean(fields["insurance"]) ?? findPayer(body);

  const memberMatch = body.match(MEMBER_RE);
  const memberId =
    extractMemberId(fields["member id"]) ?? (memberMatch ? memberMatch[1] : null);

  return {
    child_name: childName,
    dob_or_age: dobOrAge,
    parent_contact: parentContact,
    discipline,
    diagnosis_or_concern: concern,
    payer,
    member_id: memberId,
  };
}

function unlabeledName(body: string): string | null {
  const patterns = [
    /\b(?:son|daughter|child|hijo|hija)\s+(?:is\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\breferral for ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bfor my (?:son|daughter|child) ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\bpor mi (?:hijo|hija) ([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\d[ -]year[- ]old\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
    /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)'s\s+(?:dob|appointment|eval)/i,
  ];
  for (const re of patterns) {
    const m = body.match(re);
    if (m) return m[1];
  }
  return null;
}

function unlabeledContact(body: string): string | null {
  const phone = body.match(PHONE_RE);
  const email = body.match(EMAIL_RE);
  const parts = [phone?.[0], email?.[0]].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

const SAFEGUARDING_PATTERNS: RegExp[] = [
  /\brough with\b/i,
  /\bgetting rough\b/i,
  /\bhits?\b|\bhitting\b/i,
  /\bhurt(s|ing)?\b/i,
  /\babus(e|ed|ing|ive)\b/i,
  /\bneglect(ed|ing|ful)?\b/i,
  /\bunsafe\b/i,
  /\bscared of\b/i,
  /\bafraid of (his|her|the|dad|mom|mother|father)/i,
  /\bharm(ed|ing)?\b/i,
  /\bbruis(e|es|ed|ing)\b/i,
  /\bmolest/i,
  /\bhitting (him|her)\b/i,
  /\bnot safe\b/i,
  /\bviolent\b/i,
];

/** Cautious by design: recall over precision, since a human reviews every flag. */
export function detectSafeguarding(item: InboxItem): boolean {
  const text = `${item.subject}\n${item.body}`;
  return SAFEGUARDING_PATTERNS.some((re) => re.test(text));
}

const SAME_DAY_RE =
  /\btoday'?s?\b|\bsame[- ]day\b|\bthis (?:morning|afternoon)\b|\b\d{1,2}\s*(?:am|pm)\b/i;
const RESCHEDULE_RE = /\breschedul|\bcancel|\bcan'?t make|\bcannot make|\bmove (?:my|the|our) appointment/i;

export function isSameDayOperational(item: InboxItem): boolean {
  const text = `${item.subject}\n${item.body}`;
  return RESCHEDULE_RE.test(text) && SAME_DAY_RE.test(text);
}

export function classify(item: InboxItem): Classification {
  const text = `${item.subject}\n${item.body}`.toLowerCase();

  if (detectSafeguarding(item)) return "safeguarding";

  if (/\bunsubscribe\b|\bspecial offer\b|\bviagra\b|\blimited time\b/.test(text)) {
    return "spam";
  }

  // Incomplete fax referral → missing paperwork.
  if (item.channel === "fax_referral" && /\[blank\]/i.test(item.body)) {
    return "missing_paperwork";
  }

  if (RESCHEDULE_RE.test(text)) return "scheduling";

  // Advice-seeking question with no booking intent.
  const asksAdvice =
    /\bis it normal\b|\bshould i (?:be|worry|wait)\b|\bshould we\b|\bnormal that\b|\bworried\b/.test(
      text,
    );
  const wantsBooking = /\bbook|\beval|\bappointment|\bschedul|\bopening|\bslot/.test(
    text,
  );
  // "advice before booking anything" is an advice request, not a booking request.
  const explicitlyAdvice = /\badvice\b|\bbefore booking\b/.test(text);
  if (asksAdvice && (!wantsBooking || explicitlyAdvice)) return "clinical_question";

  if (/\bbill|\binvoice|\bcharge[d]?\b|\bcopay|\bpayment\b/.test(text)) {
    return "billing_question";
  }

  if (
    item.channel === "fax_referral" ||
    /\breferral\b|\bevaluation\b|\beval\b|\brefer\b|evaluaci|necesita/.test(text)
  ) {
    return "new_referral";
  }

  return "other";
}

export function baselineUrgency(
  item: InboxItem,
  classification: Classification,
): Urgency {
  if (classification === "safeguarding") return "P0";
  if (classification === "spam") return "P3";
  if (isSameDayOperational(item)) return "P1";
  return "P2";
}

/** Full rule-based understanding — the fallback when the LLM is unavailable. */
export function ruleUnderstanding(item: InboxItem): Understanding {
  const classification = classify(item);
  const intake = extractIntake(item);
  return {
    classification,
    urgency: baselineUrgency(item, classification),
    extracted_intake: intake,
    discipline: intake.discipline,
    language: detectLanguage(item.body),
    preferences: parseLabeledFields(item.body)["preferred availability"]
      ? clean(parseLabeledFields(item.body)["preferred availability"])
      : null,
    safety_flag: detectSafeguarding(item),
    intent: `${classification.replace(/_/g, " ")} via ${item.channel.replace(/_/g, " ")}`,
    same_day_operational: isSameDayOperational(item),
    source: "rules",
  };
}

export { parseLabeledFields };
