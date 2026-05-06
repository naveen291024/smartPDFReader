/**
 * fieldDetector.ts
 * Multi-strategy heuristic field detector.
 *
 * Key OCR fix: Tesseract returns individual words. We first merge nearby
 * words on the same row into "phrase tokens" (e.g. ["Account","Number:"] →
 * "Account Number:"), then apply label/value detection on the tokens.
 *
 * Strategies (applied in order):
 *  A – Inline colon in a single token:  "Account Number: 1234567"
 *  B – Same row, large gap:             [Account Number:]  [1234567]
 *  C – Label row above value row:       [Account Number:]
 *                                        [1234567]
 *  D – Trailing-colon label + next row value (loose fallback)
 */

import type { RawTextItem, PageDimensions } from "./pdfExtractor";
import type { FormField, FieldType, BoundingBox } from "@/store/formStore";

// ── Tuning constants ──────────────────────────────────────────────────────────
const Y_TOLERANCE    = 14;   // px  – same-row Y spread
const WORD_MERGE_GAP = 12;   // px  – max gap to merge adjacent words into one phrase token
                              //        (kept small to avoid merging labels with adjacent values)
const COL_GAP_MIN    = 8;    // px  – min gap separating label from value
const NEXT_ROW_MAX   = 90;   // px  – max vertical distance for label-above-value match
// ─────────────────────────────────────────────────────────────────────────────

// Post Office / India Post account opening form field labels
const FORM_LABEL_KEYWORDS = [
  // Personal details
  "name", "surname", "first", "last", "middle", "full", "maiden",
  "father", "mother", "husband", "guardian", "relation", "spouse",
  "gender", "sex", "dob", "date of birth", "birth", "age",
  "nationality", "marital", "category",

  // Identity & KYC
  "pan", "aadhaar", "aadhar", "uid", "voter", "passport", "kyc",
  "identity", "proof", "document", "photo",

  // Contact
  "mobile", "phone", "telephone", "email", "e-mail",

  // Address
  "address", "residential", "permanent", "correspondence",
  "house", "street", "road", "locality", "area", "landmark",
  "village", "post", "taluka", "tehsil", "district", "city",
  "state", "pincode", "pin", "country",

  // Post Office account specifics
  "account", "cif", "cif id", "customer", "so", "ho", "sub office", "head office",
  "post office", "branch", "scheme", "type",
  "sb", "rd", "td", "ppf", "nsc", "kvp", "mis", "scss", "ssa",
  "agent", "code", "id", "number", "ref", "reference",
  "initial", "deposit", "amount", "installment",
  "tenure", "period", "maturity", "interest",
  "nomination", "nominee", "joint", "holder", "minor",
  "mode", "payment", "standing", "instruction",
  "signature", "thumb", "impression",
  "introducer", "introduction", "witness", "passbook",
  "date", "opening", "closing",
  "income", "occupation", "designation", "employer", "salary",
  "source", "funds",
];

/**
 * Ordered list of known label phrases for this form (longest first so
 * "Mother Maiden Name" matches before "Mother" or "Name").
 * These are used to split merged OCR tokens like "First Name John" into
 * label="First Name" + value="John" even when there is no colon.
 */
const KNOWN_LABEL_PHRASES: string[] = [
  // 4-word
  "date of birth",
  "mother maiden name",
  "mother's maiden name",
  "mothers maiden name",
  // 3-word
  "first name", "last name", "middle name", "full name",
  "cif id", "cif no",
  "pan number", "pan no",
  "mobile number", "mobile no",
  "phone number", "phone no",
  "email id", "email address",
  "account number", "account no",
  "aadhaar number", "aadhar number",
  "date of opening",
  "father name", "father's name",
  "mother name", "mother's name",
  "nominee name",
  "post office",
  "pin code",
  // 2-word
  "applicant name",
  "first name", "last name", "middle name",
  "mobile", "email", "pan", "cif",
  "dob", "gender", "age",
  "nominee", "pincode",
];

const SKIP_PATTERNS = [
  /^(page|form|instructions|declaration|seal|stamp|for office|for post office|do not|please|note:|terms|conditions|office use|photograph|paste|affix|sl\.?\s*no|sr\.?\s*no|s\.?no|acknowledgement|receipt)/i,
  // Long sentences are instructions, not labels
  /^.{80,}$/,
  // Pure numbers (row counters like "1.", "2.")
  /^\d{1,2}\.?$/,
  // All-caps header with no colon and > 3 words (section title)
  /^[A-Z][A-Z\s]{15,}$/,
  // Section sub-headings: sentence ending with colon and 3+ words (no inline value)
  // e.g. "Applicant's Details:", "Please provide below details:"
  /^[A-Za-z].{10,}:$/,
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/(^_|_$)/g, "").substring(0, 40);
}

function inferFieldType(label: string, value: string): FieldType {
  const l = label.toLowerCase();
  const v = value.toLowerCase().trim();
  if (/date|dob|birth|opening|closing|maturity/.test(l)) return "date";
  if (/gender|sex/.test(l)) return "select";
  if (/\btype\b|scheme|mode|payment|occupation|category|marital|nationality/.test(l)) return "select";
  if (/^(yes|no|true|false|y|n)$/i.test(v) || /^[✓✗☑☐]$/.test(v)) return "checkbox";
  if (/amount|deposit|installment|income|salary|age|pin|tenure|period/.test(l) && /^\d/.test(v)) return "number";
  if (/^\d{1,3}(,\d{3})*(\.\d{2})?$/.test(v)) return "number";
  if (/^\d+$/.test(v) && v.length <= 8) return "number";
  return "text";
}

function inferSelectOptions(label: string): string[] | undefined {
  const l = label.toLowerCase();
  if (/gender|sex/.test(l)) return ["Male", "Female", "Transgender"];
  if (/scheme/.test(l)) return ["SB", "RD", "TD", "PPF", "NSC", "KVP", "MIS", "SCSS", "SSA"];
  if (/account.*type|type.*account/.test(l)) return ["Single", "Joint A", "Joint B", "Minor"];
  if (/mode.*pay|payment.*mode/.test(l)) return ["Cash", "Cheque", "DD", "NEFT", "Standing Instruction"];
  if (/occupation/.test(l)) return ["Salaried", "Self-Employed", "Business", "Student", "Retired", "Homemaker", "Other"];
  if (/category/.test(l)) return ["General", "Minor", "HUF", "Trust", "Institutional"];
  if (/marital/.test(l)) return ["Single", "Married", "Divorced", "Widowed"];
  if (/nationality/.test(l)) return ["Indian", "NRI", "Other"];
  if (/relation/.test(l)) return ["Father", "Mother", "Spouse", "Son", "Daughter", "Brother", "Sister", "Guardian", "Other"];
  if (/country/.test(l)) return ["India", "Other"];
  return undefined;
}

/** Returns true for blank placeholder tokens OCR reads as _____, ....., ——— etc. */
function isBlankPlaceholder(text: string): boolean {
  const t = text.trim();
  // Purely composed of underscores, dashes, dots, pipes, box-drawing or table chars
  if (/^[_\-\.\|\u2014\u2013\u2012\u005F\u2500-\u257F\+\s]+$/.test(t)) return true;
  // Mostly underscores / dashes (OCR sometimes mixes in noise chars)
  const nonBlank = t.replace(/[_\-\.\s\|\u2500-\u257F\+]/g, "");
  if (t.length >= 3 && nonBlank.length / t.length < 0.25) return true;
  // Character-entry box artefacts: OCR reads the borders of printed letter-entry
  // boxes as repeating letters like FTFTTTTFTTT, LLLLL, IIIIIII, PIDEI, BIZTEDI.
  // Detect: string of 4+ chars where unique char count ≤ 3 AND all chars are
  // common box-border OCR misreads (F, T, L, I, |, [, ], E, B, P, D, Z)
  if (t.length >= 4) {
    const unique = new Set(t.toUpperCase().replace(/\s/g, ""));
    const boxChars = /^[FTLIEB|\[\]PD{}Z0O\-_]+$/i.test(t.replace(/\s/g, ""));
    if (boxChars && unique.size <= 4) return true;
    // High repetition ratio: same 1-2 chars make up > 70% of the string
    const chars = t.replace(/\s/g, "");
    const topChar = [...unique].sort((a, b) =>
      (chars.split(b).length - 1) - (chars.split(a).length - 1)
    )[0];
    if (topChar && chars.split(topChar).length - 1 >= chars.length * 0.6 && chars.length >= 5) return true;
  }
  return false;
}

/** Returns true for format hints that should not be treated as values */
function isFormatHint(text: string): boolean {
  const t = text.trim();
  // Parenthesised hints: (DD/MM/YYYY), (optional), (Rs.), (in Rs.)
  if (/^\(.*\)$/.test(t)) return true;
  // Slash-separated date/number formats: DD/MM/YYYY, MM-YYYY
  if (/^(dd|mm|yyyy|yy)[\/_\-](mm|dd|yyyy)[\/_\-]?(yyyy|yy)?$/i.test(t)) return true;
  // e.g., i.e., etc.
  if (/^(e\.g\.|i\.e\.|etc\.?|viz\.?)$/i.test(t)) return true;
  return false;
}

/** True for characters OCR produces for empty tick-box: □ ☐ [ ] [x] [✓] ○ */
function isCheckboxToken(text: string): boolean {
  const t = text.trim();
  if (/^[□☐○◯●■☑✓✗]$/.test(t)) return true;
  if (/^\[\s*[xX✓\s]?\s*\]$/.test(t)) return true;   // [ ] [x] [✓]
  return false;
}

/**
 * True for tokens that look like individual digit-entry boxes.
 * OCR of  [_][_][_]  often comes out as  |  |  | , or  _  _  _  (handled by
 * isBlankPlaceholder), or a single character per box.
 */
function isDigitBoxToken(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Single digit character (one box, one number)
  if (/^[0-9]$/.test(t)) return true;
  // Short run of digits — OCR merged a few adjacent boxes: "12", "123"
  if (/^\d{1,4}$/.test(t)) return true;
  // Pipe / bracket / underscore box artefacts (empty box)
  if (/^[|\[\]_{}]$/.test(t)) return true;
  // OCR joining a few box chars: "| |" "[][]" etc.
  if (/^[|\[\]_\s]{2,6}$/.test(t)) return true;
  return false;
}

/**
 * True if a row token is a section heading that provides GROUP context for
 * sub-fields below it, but is not itself a fillable field.
 * Examples: "1. *Applicant's Name", "2. *ATM Card required", "3. Please provide"
 */
function isSectionHeading(text: string): boolean {
  const t = text.trim();
  // Numbered section: starts with digit(s), dot, optional star/asterisk
  if (/^\d+\.\s*[*'\u2018\u2019]?\s*[A-Z]/i.test(t)) return true;
  // Starred mandatory section marker: "*Applicant's Name"
  if (/^[*\u2022]\s*[A-Z]/i.test(t) && t.split(/\s+/).length <= 5) return true;
  return false;
}

/**
 * Extract clean section heading text (strip leading number, dot, star).
 * e.g. "1. *Applicant's Name" → "Applicant's Name"
 */
function sectionHeadingLabel(text: string): string {
  return text
    .replace(/^\d+\.\s*/, "")
    .replace(/^[*\u2022]\s*/, "")
    .replace(/:+$/, "")
    .trim();
}
/**
 * Try to split a merged token into (labelPart, valuePart) using KNOWN_LABEL_PHRASES.
 * Returns null if no known label prefix is found.
 * Handles both "First Name John" and "First Name: John" formats.
 * Also catches "CIF ID 98765432" or "Mobile Number 9876543210".
 */
function splitOnKnownLabel(text: string): { label: string; value: string } | null {
  const t = text.trim();
  const lower = t.toLowerCase();
  // Try longest phrases first
  for (const phrase of KNOWN_LABEL_PHRASES) {
    if (!lower.startsWith(phrase)) continue;
    const afterPhrase = t.slice(phrase.length).trimStart();
    if (!afterPhrase) continue; // nothing after phrase — just a label, no value inline
    // Allow optional colon/dash separator after the label phrase
    const valuePart = afterPhrase.replace(/^[:\-–—]\s*/, "").trim();
    if (valuePart.length === 0) continue;
    // The value should not itself look like another label phrase
    const valueLower = valuePart.toLowerCase();
    const startsWithLabel = KNOWN_LABEL_PHRASES.some((p) => valueLower.startsWith(p));
    if (startsWithLabel) continue;
    return { label: t.slice(0, phrase.length), value: valuePart };
  }
  return null;
}

function isLikelyLabel(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 2 || t.length > 80) return false;
  if (SKIP_PATTERNS.some((p) => p.test(t))) return false;
  if (isBlankPlaceholder(t) || isFormatHint(t) || isCheckboxToken(t) || isDigitBoxToken(t)) return false;
  // Strongest signal: ends with colon
  if (t.endsWith(":")) return true;
  // Keyword match only accepted for SHORT phrases (≤ 5 words) — avoids matching
  // instruction sentences that happen to contain words like "name" or "date".
  const wordCount = t.split(/\s+/).length;
  if (wordCount > 5) return false;
  const lower = t.toLowerCase();
  return FORM_LABEL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Confidence below this is treated as handwritten (matches backend HW_CONFIDENCE_THRESHOLD) */
const HW_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Returns true if a row contains at least one token that is either:
 *  a) a low-confidence handwritten item (confidence < HW_CONFIDENCE_THRESHOLD), OR
 *  b) a plausible non-label value token
 * Starting search from `startIdx` (tokens before the label are excluded).
 * This is used to distinguish genuine form fields (always have a fill-in slot)
 * from section headings / instruction text (never do).
 */
function hasHandwrittenOrValueOnRow(row: Row, startIdx: number): boolean {
  for (let i = startIdx; i < row.tokens.length; i++) {
    const tok = row.tokens[i];
    // Low-confidence = handwritten text in the value slot
    if (tok.confidence !== undefined && tok.confidence < HW_CONFIDENCE_THRESHOLD) return true;
    // Blank placeholder (empty input box) still signals a fillable field
    if (isBlankPlaceholder(tok.text)) return true;
    // Digit-box artefacts = empty number boxes
    if (isDigitBoxToken(tok.text)) return true;
    // A real value token (not another label)
    if (isLikelyValue(tok.text) && !isLikelyLabel(tok.text)) return true;
  }
  return false;
}

/** Same check but working across two rows (label row + value row below it). */
function hasHandwrittenOrValueBelow(valueRow: Row): boolean {
  return valueRow.tokens.some(
    (tok) =>
      (tok.confidence !== undefined && tok.confidence < HW_CONFIDENCE_THRESHOLD) ||
      isBlankPlaceholder(tok.text) ||
      isDigitBoxToken(tok.text) ||
      (isLikelyValue(tok.text) && !isLikelyLabel(tok.text))
  );
}

function isLikelyValue(text: string): boolean {
  const t = text.trim();
  if (!t || t.length < 1) return false;
  if (t.endsWith(":")) return false;         // looks like a label
  if (isBlankPlaceholder(t)) return false;    // blank input line
  if (isFormatHint(t)) return false;          // (DD/MM/YYYY) etc.
  if (SKIP_PATTERNS.some((p) => p.test(t))) return false;
  return true;
}

// ── Word grouping and merging ─────────────────────────────────────────────────

/**
 * Deduplicate raw text items from two-pass OCR scanning.
 * Removes items whose bounding box centre is within 20px of another item
 * that has the same or very similar text. Keeps the item with longer text.
 */
function deduplicateItems(items: RawTextItem[]): RawTextItem[] {
  const kept: RawTextItem[] = [];
  for (const item of items) {
    const cx = item.x + item.width / 2;
    const cy = item.y + item.height / 2;
    const isDuplicate = kept.some((k) => {
      const kx = k.x + k.width / 2;
      const ky = k.y + k.height / 2;
      if (Math.abs(kx - cx) > 20 || Math.abs(ky - cy) > 20) return false;
      // Same centre — check text similarity (match if either starts with the other)
      const a = item.text.trim().toLowerCase().slice(0, 6);
      const b = k.text.trim().toLowerCase().slice(0, 6);
      return a === b || a.startsWith(b) || b.startsWith(a);
    });
    if (!isDuplicate) {
      // If a near-duplicate already exists, replace if current text is longer
      const nearIdx = kept.findIndex((k) => {
        const kx = k.x + k.width / 2;
        const ky = k.y + k.height / 2;
        return Math.abs(kx - cx) <= 20 && Math.abs(ky - cy) <= 20;
      });
      if (nearIdx >= 0 && item.text.length > kept[nearIdx].text.length) {
        kept[nearIdx] = item;
      } else if (nearIdx < 0) {
        kept.push(item);
      }
    }
  }
  return kept;
}

interface Row {
  tokens: RawTextItem[];  // merged phrase tokens (not raw OCR words)
  y: number;
  page: number;
}

/**
 * Step 1: Group raw text items into rows by Y proximity.
 * Step 2: Within each row, merge adjacent words that are close together
 *         into phrase tokens. Words separated by a large gap (>COL_GAP_MIN)
 *         stay as separate tokens (likely different columns).
 */
/**
 * Strip table/box characters that OCR picks up from cell borders.
 * These characters add noise before/after real label and value text.
 *
 * Removes: | + ┌ ┐ └ ┘ ├ ┤ ┬ ┴ ┼ ─ │ ═ ║ ╔ ╗ ╚ ╝  and ASCII - _ when surrounding real text
 */
function cleanText(raw: string): string {
  return raw
    // Remove Unicode box-drawing characters
    .replace(/[\u2500-\u257F]+/g, " ")
    // Remove isolated pipes and plus signs (table cell borders)
    .replace(/\|/g, " ")
    .replace(/\+/g, " ")
    // Remove leading/trailing dashes that are border artefacts
    .replace(/^[-=]+|[-=]+$/g, "")
    // Collapse multiple spaces
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** True if a raw OCR item is purely a table border / cell separator with no real text. */
function isBorderToken(text: string): boolean {
  // After stripping border chars, nothing meaningful remains
  return cleanText(text).length === 0;
}

function buildRows(items: RawTextItem[]): Row[] {
  // ── Step 0: clean text and drop pure border tokens ──
  const cleanedItems: RawTextItem[] = items
    .map((item) => ({ ...item, text: cleanText(item.text) }))
    .filter((item) => item.text.length > 0 && !isBorderToken(item.text));

  // ── Step 1: group by Y row ──
  const rawRows: { items: RawTextItem[]; y: number; page: number }[] = [];
  for (const item of cleanedItems) {
    const row = rawRows.find(
      (r) => r.page === item.page && Math.abs(r.y - item.y) <= Y_TOLERANCE
    );
    if (row) {
      row.items.push(item);
    } else {
      rawRows.push({ items: [item], y: item.y, page: item.page });
    }
  }
  rawRows.forEach((r) => r.items.sort((a, b) => a.x - b.x));
  rawRows.sort((a, b) => a.page - b.page || a.y - b.y);

  // ── Step 2: merge adjacent close words into phrase tokens ──
  const rows: Row[] = rawRows.map((rawRow) => {
    const tokens: RawTextItem[] = [];
    for (const word of rawRow.items) {
      const last = tokens[tokens.length - 1];
      if (last) {
        const gap = word.x - (last.x + last.width);
        if (gap <= WORD_MERGE_GAP) {
          // Merge into last token — take the minimum confidence (handwriting lowers it)
          const mergedText = last.text + " " + word.text;
          const mergedConf = (last.confidence !== undefined && word.confidence !== undefined)
            ? Math.min(last.confidence, word.confidence)
            : (last.confidence ?? word.confidence);
          tokens[tokens.length - 1] = {
            text: mergedText,
            x: last.x,
            y: last.y,
            width: (word.x + word.width) - last.x,
            height: Math.max(last.height, word.height),
            page: last.page,
            confidence: mergedConf,
          };
          continue;
        }
      }
      tokens.push({ ...word });
    }
    return { tokens, y: rawRow.y, page: rawRow.page };
  });

  return rows;
}

// ── Field construction ────────────────────────────────────────────────────────

function makeField(
  label: string,
  rawValue: string,
  bbox: BoundingBox,
  usedIds: Set<string>,
  forceCreate = false,
  valueConfidence?: number,
): FormField | null {
  const cleanLabel = label.replace(/:+$/, "").trim();
  if (!cleanLabel) return null;
  if (!forceCreate && !rawValue.trim()) return null;  // skip only if not forced
  if (cleanLabel.length < 2 || cleanLabel.length > 80) return null;

  // A label that ends with ":" AND has no value is a section sub-heading, not a field.
  // e.g. "Applicant's Details:", "Address:", "Please fill below:"
  // We allow short single-word labels ("Name:", "Date:") — they are real fields.
  const originalHasColon = label.trimEnd().endsWith(":");
  const wordCount = cleanLabel.split(/\s+/).length;
  if (originalHasColon && !rawValue.trim() && wordCount >= 3) return null;

  const type = inferFieldType(cleanLabel, rawValue);
  const options = type === "select" ? inferSelectOptions(cleanLabel) : undefined;

  let baseId = slugify(cleanLabel) || `field_${usedIds.size}`;
  let id = baseId;
  let counter = 1;
  while (usedIds.has(id)) id = `${baseId}_${counter++}`;
  usedIds.add(id);

  let value: string | boolean = rawValue.trim();
  if (type === "checkbox") {
    value = ["yes", "true", "y", "✓", "☑", "1"].includes(rawValue.toLowerCase().trim());
  }

  return { id, label: cleanLabel, type, value, options, bbox, required: true,
    valueConfidence,
    isHandwritten: valueConfidence !== undefined && valueConfidence < 0.75,
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function detectFields(
  items: RawTextItem[],
  pages: PageDimensions[]
): FormField[] {
  // ── Pre-step: deduplicate near-identical items from two-pass OCR ──────────
  // Pass 1 and Pass 2 produce items at nearly the same coordinates with
  // the same (or nearly same) text. Keep only the best one per position.
  const dedupedItems = deduplicateItems(items);
  const rows = buildRows(dedupedItems);
  const fields: FormField[] = [];
  const usedIds = new Set<string>();

  // ── Strategy X: Digit-box fields ─────────────────────────────────────────
  // Handles CIF ID, Account Number, Aadhaar, PAN, Mobile — any label followed
  // by a sequence of individual box-digit tokens on the SAME ROW.
  // Runs first so it takes priority over all other strategies.
  //
  // Key insight: OCR may return "CIF" and "ID" as two separate tokens.
  // We therefore try SLIDING WINDOWS of 1, 2, and 3 consecutive tokens to
  // match multi-word known labels before looking for the digits to the right.
  const DIGIT_BOX_LABELS = [
    // longest first — checked before shorter aliases
    "account number", "account no",
    "aadhaar number", "aadhar number",
    "pan number", "pan no",
    "mobile number", "mobile no",
    "phone number", "phone no",
    "ifsc code",
    "pin code",
    "cif id", "cif no",
    // single-word
    "aadhaar", "aadhar", "uid",
    "mobile", "phone",
    "pincode",
    "ifsc",
    "cif",
    "pan",
  ];

  for (const row of rows) {
    // Try windows of 3, 2, 1 tokens as label (longest wins)
    for (let ti = 0; ti < row.tokens.length; ti++) {
      let labelText = "";
      let labelEndIdx = -1; // index of last token that forms the label

      // Attempt windows: 3 tokens, then 2, then 1
      outer:
      for (const windowSize of [3, 2, 1]) {
        if (ti + windowSize - 1 >= row.tokens.length) continue;
        const windowTokens = row.tokens.slice(ti, ti + windowSize);
        const joined = windowTokens.map((t) => t.text.replace(/:+$/, "").trim()).join(" ").toLowerCase();

        if (DIGIT_BOX_LABELS.includes(joined)) {
          labelText = windowTokens.map((t) => t.text.replace(/:+$/, "").trim()).join(" ");
          labelEndIdx = ti + windowSize - 1;
          break outer;
        }
      }

      if (!labelText || labelEndIdx < 0) continue;
      if (usedIds.has(slugify(labelText))) continue;

      console.log(`[StrategyX] Matched digit-box label "${labelText}" at row y=${row.y}`);

      // Collect all consecutive digit/box tokens to the right
      const digitToks: RawTextItem[] = [];
      for (let di = labelEndIdx + 1; di < row.tokens.length; di++) {
        const dtok = row.tokens[di];
        if (isLikelyLabel(dtok.text)) break;
        if (isDigitBoxToken(dtok.text) || isBlankPlaceholder(dtok.text)) {
          digitToks.push(dtok);
        } else if (digitToks.length > 0) {
          break;
        } else {
          // The token after the label may be a merged value like "12345678" or "9876543210"
          // Accept it if it is all digits (OCR merged the boxes into one token)
          if (/^\d{4,}$/.test(dtok.text.trim())) {
            digitToks.push(dtok);
          }
          break;
        }
      }

      const labelTok = row.tokens[ti];

      // Also check if the label token itself merges the digits (e.g. "CIF ID 12345678")
      const inlineSplit = splitOnKnownLabel(labelTok.text);
      if (inlineSplit && /^\d{3,}$/.test(inlineSplit.value.replace(/\s+/g, ""))) {
        const digits = inlineSplit.value.replace(/\s+/g, "");
        const bbox: BoundingBox = {
          page: row.page,
          x: labelTok.x + labelTok.width * (inlineSplit.label.length / labelTok.text.length),
          y: labelTok.y - labelTok.height,
          width: Math.max(labelTok.width * (1 - inlineSplit.label.length / labelTok.text.length), 80),
          height: labelTok.height + 4,
        };
        const f = makeField(inlineSplit.label, digits, bbox, usedIds);
        if (f) { f.type = "number"; fields.push(f); }
        continue;
      }

      if (digitToks.length === 0) {
        // No digit tokens found — still create empty field so form shows the input
        const lastLabelTok = row.tokens[labelEndIdx];
        const emptyBbox: BoundingBox = {
          page: row.page,
          x: lastLabelTok.x + lastLabelTok.width + 10,
          y: lastLabelTok.y - lastLabelTok.height,
          width: 160,
          height: lastLabelTok.height + 4,
        };
        const f = makeField(labelText, "", emptyBbox, usedIds, true);
        if (f) { f.type = "number"; fields.push(f); }
        continue;
      }

      // Concatenate all digit characters, discard box/pipe artefacts
      const digitValue = digitToks
        .map((t) => t.text.trim().replace(/[|\[\]_{}\s]/g, ""))
        .filter(Boolean)
        .join("");

      const firstDT = digitToks[0];
      const lastDT = digitToks[digitToks.length - 1];
      const dbBbox: BoundingBox = {
        page: row.page,
        x: firstDT.x,
        y: firstDT.y - firstDT.height,
        width: Math.max(lastDT.x + lastDT.width - firstDT.x, 80),
        height: firstDT.height + 4,
      };

      const f = makeField(labelText, digitValue || "", dbBbox, usedIds, true);
      if (f) { f.type = "number"; fields.push(f); }
    }
  }

  // ── Strategy A: Inline colon inside a single merged token ────────────────
  // Handles: "Account Number: 1234567"  or  "Name: John Smith"
  for (const row of rows) {
    for (const token of row.tokens) {
      const colonIdx = token.text.indexOf(":");
      if (colonIdx < 1) continue;

      const labelPart = token.text.substring(0, colonIdx).trim();
      const valuePart = token.text.substring(colonIdx + 1).trim();

      if (!labelPart || !valuePart) continue;
      if (!isLikelyLabel(labelPart)) continue;
      if (!isLikelyValue(valuePart)) continue;

      // bbox covers the value portion (right part of token)
      const labelFrac = colonIdx / token.text.length;
      const bbox: BoundingBox = {
        page: row.page,
        x: token.x + token.width * labelFrac,
        y: token.y - token.height,
        width: Math.max(token.width * (1 - labelFrac), 80),
        height: token.height + 4,
      };

      const field = makeField(labelPart, valuePart, bbox, usedIds, false, token.confidence);
      if (field) fields.push(field);
    }
  }

  // ── Strategy A2: Known-label prefix split (no colon required) ───────────
  // Handles OCR merges like "First Name John" → label="First Name", value="John"
  // Also catches "CIF ID 98765432" or "Mobile Number 9876543210".
  for (const row of rows) {
    for (const token of row.tokens) {
      // Skip if already handled by Strategy A (has colon split)
      if (token.text.includes(":")) continue;

      const split = splitOnKnownLabel(token.text);
      if (!split) continue;
      if (usedIds.has(slugify(split.label))) continue;
      if (!isLikelyValue(split.value)) continue;

      const labelFrac = split.label.length / token.text.length;
      const bbox: BoundingBox = {
        page: row.page,
        x: token.x + token.width * labelFrac,
        y: token.y - token.height,
        width: Math.max(token.width * (1 - labelFrac), 80),
        height: token.height + 4,
      };

      const field = makeField(split.label, split.value, bbox, usedIds, false, token.confidence);
      if (field) fields.push(field);
    }
  }
  // Handles rows like: [Post Office:]  [_____]  [Date:]  [_____]  (DD/MM/YYYY)
  // For each label token, find its value = the first non-label, non-hint token
  // to its right before the next label. If value slot is blank/missing, use "".
  for (const row of rows) {
    if (row.tokens.length < 1) continue;

    // Identify all label positions in this row
    const labelPositions: number[] = [];
    for (let i = 0; i < row.tokens.length; i++) {
      const tok = row.tokens[i];
      // Skip tokens already captured inline by Strategy A
      if (tok.text.includes(":") && !tok.text.endsWith(":")) continue;
      if (isLikelyLabel(tok.text)) labelPositions.push(i);
    }

    for (let li = 0; li < labelPositions.length; li++) {
      const labelIdx = labelPositions[li];
      const nextLabelIdx = labelPositions[li + 1] ?? row.tokens.length;
      const labelTok = row.tokens[labelIdx];
      const labelText = labelTok.text.replace(/:+$/, "").trim();

      if (usedIds.has(slugify(labelText))) continue;

      // Skip label token and look for handwritten neighbour on same row
      if (!hasHandwrittenOrValueOnRow(row, labelIdx + 1)) continue;

      // Examine tokens between this label and the next label
      const betweenToks = row.tokens.slice(labelIdx + 1, nextLabelIdx);

      let valueTok: RawTextItem | null = null;
      let valueBbox: BoundingBox | null = null;

      // Scenario 3: checkbox options  □ / [x] tokens right after label
      // e.g.  "Nomination:  □ Yes  □ No"
      let checkboxOptionsDetected = false;
      {
        const cbPairs: Array<{ label: string; checked: boolean }> = [];
        let i = 0;
        while (i < betweenToks.length) {
          const tok = betweenToks[i];
          if (isCheckboxToken(tok.text)) {
            const isChecked = /[xX✓■●☑]/.test(tok.text);
            // Option label = next non-checkbox, non-blank token(s)
            let optLabel = "";
            let j = i + 1;
            while (j < betweenToks.length && !isCheckboxToken(betweenToks[j].text)) {
              if (isLikelyValue(betweenToks[j].text)) optLabel += (optLabel ? " " : "") + betweenToks[j].text;
              j++;
            }
            if (optLabel) cbPairs.push({ label: optLabel, checked: isChecked });
            i = j;
          } else {
            i++;
          }
        }
        if (cbPairs.length >= 2) {
          checkboxOptionsDetected = true;
          // Represent as a select field whose options are the checkbox labels
          const firstTok = betweenToks[0] ?? labelTok;
          const lastTok = betweenToks[betweenToks.length - 1] ?? labelTok;
          const cbBbox: BoundingBox = {
            page: row.page,
            x: firstTok.x,
            y: firstTok.y - firstTok.height,
            width: Math.max(lastTok.x + lastTok.width - firstTok.x, 120),
            height: firstTok.height + 4,
          };
          const checkedOpt = cbPairs.find((p) => p.checked)?.label ?? "";
          const cbField = makeField(labelText, checkedOpt || cbPairs[0].label, cbBbox, usedIds, true);
          if (cbField) {
            cbField.type = "select";
            cbField.options = cbPairs.map((p) => p.label);
            cbField.value = checkedOpt;
            fields.push(cbField);
          }
        }
      }
      if (checkboxOptionsDetected) continue;

      // Scenario 2: digit boxes  — sequence of box/single-char tokens after label
      // e.g.  "Account No:  |_| |_| |_| |_| |_|"
      const digitBoxToks = betweenToks.filter((t) => isDigitBoxToken(t.text) || isBlankPlaceholder(t.text));
      const isDigitBoxField = digitBoxToks.length >= 3 && digitBoxToks.length === betweenToks.filter((t) => {
        const g = t.x - (labelTok.x + labelTok.width);
        return g >= COL_GAP_MIN;
      }).length;

      // Scenario 1: blank text field or real value
      if (!isDigitBoxField) {
        for (let vi = labelIdx + 1; vi < nextLabelIdx; vi++) {
          const candidate = row.tokens[vi];
          const gap = candidate.x - (labelTok.x + labelTok.width);
          if (gap < COL_GAP_MIN) continue;
          if (isLikelyValue(candidate.text)) { valueTok = candidate; break; }
        }
      }

      const valueText = valueTok ? valueTok.text : "";

      if (valueTok) {
        valueBbox = {
          page: row.page,
          x: valueTok.x,
          y: valueTok.y - valueTok.height,
          width: Math.max(valueTok.width, 80),
          height: valueTok.height + 4,
        };
      } else {
        // Blank field or digit-box field — estimate bbox from gap between labels
        const nextTok = row.tokens[nextLabelIdx];
        const fieldX = labelTok.x + labelTok.width + 10;
        const fieldW = nextTok ? nextTok.x - fieldX - 5 : 120;
        valueBbox = {
          page: row.page,
          x: fieldX,
          y: labelTok.y - labelTok.height,
          width: Math.max(fieldW, 80),
          height: labelTok.height + 4,
        };
      }

      const field = makeField(labelText, valueText, valueBbox!, usedIds, /* forceCreate */ true, valueTok?.confidence);
      if (field) {
        if (isDigitBoxField) field.type = "number";
        fields.push(field);
      }
    }
  }

  // ── Strategy E: Standalone checkbox-option rows ──────────────────────────
  // Handles rows like:  □ Savings  □ Current  □ Fixed Deposit
  // (no visible label colon on the same row — label is typically above)
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    // Row must start (or nearly start) with a checkbox token
    const firstCB = row.tokens.findIndex((t) => isCheckboxToken(t.text));
    if (firstCB < 0 || firstCB > 1) continue;   // allow at most one leading non-cb token

    // Count checkbox tokens in this row
    const cbCount = row.tokens.filter((t) => isCheckboxToken(t.text)).length;
    if (cbCount < 2) continue;   // need at least 2 options to be worth a select field

    // Find the owning label from the row immediately above
    const labelRow = rows[ri - 1];
    if (!labelRow || labelRow.page !== row.page) continue;
    if (row.y - labelRow.y > NEXT_ROW_MAX) continue;

    // The closest label token in the row above
    const ownerLabel = [...labelRow.tokens].reverse().find((t) => isLikelyLabel(t.text));
    if (!ownerLabel) continue;

    const labelText = ownerLabel.text.replace(/:+$/, "").trim();
    if (usedIds.has(slugify(labelText))) continue;

    // Parse option pairs  □ OptionName
    const options: string[] = [];
    let checkedValue = "";
    let i = 0;
    while (i < row.tokens.length) {
      const tok = row.tokens[i];
      if (isCheckboxToken(tok.text)) {
        const isChecked = /[xX✓■●☑]/.test(tok.text);
        let optLabel = "";
        let j = i + 1;
        while (j < row.tokens.length && !isCheckboxToken(row.tokens[j].text)) {
          if (isLikelyValue(row.tokens[j].text)) optLabel += (optLabel ? " " : "") + row.tokens[j].text;
          j++;
        }
        if (optLabel) {
          options.push(optLabel);
          if (isChecked) checkedValue = optLabel;
        }
        i = j;
      } else {
        i++;
      }
    }
    if (options.length < 2) continue;

    const firstTok = row.tokens[0];
    const lastTok = row.tokens[row.tokens.length - 1];
    const cbBbox: BoundingBox = {
      page: row.page,
      x: firstTok.x,
      y: firstTok.y - firstTok.height,
      width: Math.max(lastTok.x + lastTok.width - firstTok.x, 120),
      height: firstTok.height + 4,
    };

    const cbField = makeField(labelText, checkedValue || options[0], cbBbox, usedIds, true);
    if (cbField) {
      cbField.type = "select";
      cbField.options = options;
      cbField.value = checkedValue;
      fields.push(cbField);
    }
  }

  // ── Strategy C: Label row ABOVE, value on the next row ───────────────────
  // Handles multi-line form layouts (very common in bank forms)
  for (let ri = 0; ri < rows.length - 1; ri++) {
    const labelRow = rows[ri];
    const valueRow = rows[ri + 1];

    if (labelRow.page !== valueRow.page) continue;
    const vertGap = valueRow.y - labelRow.y;
    if (vertGap < 0 || vertGap > NEXT_ROW_MAX) continue;

    for (const labelTok of labelRow.tokens) {
      if (!isLikelyLabel(labelTok.text)) continue;

      const labelText = labelTok.text.replace(/:+$/, "").trim();
      if (usedIds.has(slugify(labelText))) continue;

      // Only create field if value row has a handwritten/value token
      if (!hasHandwrittenOrValueBelow(valueRow)) continue;

      // Find best matching value token in next row (prefer x-aligned, fallback to first)
      const aligned = valueRow.tokens.find((vt) => {
        if (!isLikelyValue(vt.text)) return false;
        const overlapL = Math.max(vt.x, labelTok.x - 30);
        const overlapR = Math.min(vt.x + vt.width, labelTok.x + labelTok.width + 60);
        return overlapR > overlapL;
      });
      const valueTok = aligned ?? valueRow.tokens.find((vt) => isLikelyValue(vt.text));

      if (!valueTok || !isLikelyValue(valueTok.text)) continue;

      const bbox: BoundingBox = {
        page: valueRow.page,
        x: valueTok.x,
        y: valueTok.y - valueTok.height,
        width: Math.max(valueTok.width, 80),
        height: valueTok.height + 4,
      };

      const field = makeField(labelText, valueTok.text, bbox, usedIds, false, valueTok.confidence);
      if (field) fields.push(field);
    }
  }

  // ── Strategy D: Trailing-colon token + next-row value (loose fallback) ────
  for (let ri = 0; ri < rows.length - 1; ri++) {
    const row = rows[ri];
    const nextRow = rows[ri + 1];

    if (row.page !== nextRow.page) continue;
    if (nextRow.y - row.y > NEXT_ROW_MAX) continue;
    // Require handwritten/value content below before creating field
    if (!hasHandwrittenOrValueBelow(nextRow)) continue;

    for (const tok of row.tokens) {
      if (!tok.text.endsWith(":")) continue;
      const labelText = tok.text.replace(/:+$/, "").trim();
      if (usedIds.has(slugify(labelText))) continue;

      const valueTok = nextRow.tokens.find((vt) => isLikelyValue(vt.text));
      if (!valueTok) continue;

      const bbox: BoundingBox = {
        page: nextRow.page,
        x: valueTok.x,
        y: valueTok.y - valueTok.height,
        width: Math.max(valueTok.width, 80),
        height: valueTok.height + 4,
      };

      const field = makeField(labelText, valueTok.text, bbox, usedIds, false, valueTok.confidence);
      if (field) fields.push(field);
    }
  }

  // ── Strategy F: Value-above-label (inverted layout) ──────────────────────────
  // Handles forms where the printable character-box row appears ABOVE the label,
  // e.g.:
  //   [F][T][F][T][T][T]   ← OCR of printed character entry boxes (y=230)
  //   First Name            ← label (y=240)
  // For each label token not yet claimed, look at the row immediately ABOVE.
  // If that row contains box/handwriting/blank tokens, use it as the value.
  for (let ri = 1; ri < rows.length; ri++) {
    const labelRow = rows[ri];
    const aboveRow = rows[ri - 1];

    if (labelRow.page !== aboveRow.page) continue;
    const vertGap = labelRow.y - aboveRow.y;
    if (vertGap < 0 || vertGap > NEXT_ROW_MAX) continue;

    for (const labelTok of labelRow.tokens) {
      if (!isLikelyLabel(labelTok.text)) continue;

      const rawLabel = labelTok.text.replace(/:+$/, "").trim();
      if (usedIds.has(slugify(rawLabel))) continue;

      // The above row must contain box/handwritten content
      const aboveHasBoxOrHW = aboveRow.tokens.some(
        (t) =>
          isBlankPlaceholder(t.text) ||
          isDigitBoxToken(t.text) ||
          (t.confidence !== undefined && t.confidence < 0.75)
      );
      if (!aboveHasBoxOrHW) continue;

      // Find the best value token in the above row — prefer handwritten over blank
      const hwTok = aboveRow.tokens.find(
        (t) => t.confidence !== undefined && t.confidence < 0.75 && !isBlankPlaceholder(t.text)
      );
      const boxTok = aboveRow.tokens.find(
        (t) => isBlankPlaceholder(t.text) || isDigitBoxToken(t.text)
      );
      const valueTok = hwTok ?? boxTok ?? null;

      // Determine section context — find the nearest section heading above
      let sectionCtx = "";
      for (let si = ri - 1; si >= 0; si--) {
        const sRow = rows[si];
        if (sRow.page !== labelRow.page) break;
        const heading = sRow.tokens.find((t) => isSectionHeading(t.text));
        if (heading) { sectionCtx = sectionHeadingLabel(heading.text); break; }
        if (labelRow.y - sRow.y > 150) break;  // don't look too far up
      }

      const displayLabel = sectionCtx
        ? `${sectionCtx} — ${rawLabel}`
        : rawLabel;

      const anchor = valueTok ?? labelTok;
      const valueBbox: BoundingBox = {
        page: aboveRow.page,
        x: anchor.x,
        y: anchor.y - anchor.height,
        width: Math.max(anchor.width, 120),
        height: anchor.height + 4,
      };

      const valueText = (valueTok && !isBlankPlaceholder(valueTok.text) && !isDigitBoxToken(valueTok.text))
        ? valueTok.text
        : "";

      const field = makeField(displayLabel, valueText, valueBbox, usedIds, true, valueTok?.confidence);
      if (field) fields.push(field);
    }
  }

  return fields;
}
