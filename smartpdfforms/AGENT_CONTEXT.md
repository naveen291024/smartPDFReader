# SmartPDFForms — Agent Context & Continuation Guide

This file gives any AI coding agent (Copilot, Claude, Cursor, etc.) full context
to continue work on this project without any prior conversation.

---

## Project Goal

A **React/Next.js browser app** that:
1. Accepts a scanned/digital PDF (India Post / Post Office account opening form)
2. Runs in-browser OCR (Tesseract.js) to extract text + bounding boxes
3. Detects form field labels and their handwritten values using heuristics
4. Renders a **split panel UI**: left = PDF viewer with bounding-box overlays, right = editable dynamic form
5. Validates filled form with Zod and shows success/error

---

## Tech Stack

| Package | Version | Purpose |
|---|---|---|
| Next.js | ~15+ (App Router) | Framework, `src/` dir, TypeScript, Turbopack |
| react-pdf | 10.4.1 | PDF rendering (`<Document>/<Page>`) |
| pdfjs-dist | nested in react-pdf | PDF text extraction |
| tesseract.js | 7.0.0 | In-browser OCR for scanned PDFs |
| zustand | ^4 | Global state (fields, values, active field) |
| zod | ^4 | Form validation (use `.issues[0]` not `.errors[0]`) |
| framer-motion | ^11 | Animations on overlays and form fields |
| react-dropzone | ^14 | Drag-drop file upload |
| lucide-react | latest | Icons |
| tailwindcss | v4 | Styling |

### Critical worker setup (do not change)
- `public/pdf.worker.min.mjs` — copied from `node_modules/react-pdf/node_modules/pdfjs-dist/build/`
  (must match react-pdf's NESTED pdfjs version, NOT the standalone pdfjs-dist)
- `public/tesseract-worker.min.js` — Tesseract v7 worker
- `public/tesseract-core/` — Tesseract WASM files
- `public/lang-data/eng.traineddata.gz` — 10.9MB English language model (local, no CDN)

All assets are served locally because the corporate network blocks external CDNs.

---

## File Structure

```
src/
  app/
    page.tsx              # Split-panel layout, upload handler, OCR progress bar
    layout.tsx
    globals.css
    api/extract/route.ts  # Unused placeholder API route
  components/
    PDFUploader.tsx        # react-dropzone, PDF only, framer-motion wrapper
    PDFViewer.tsx          # react-pdf viewer, zoom/nav, FieldOverlay on each page
                           # IMPORTANT: loaded via next/dynamic {ssr:false} — DOMMatrix not in Node
    FieldOverlay.tsx       # Framer-motion bounding boxes over active fields
    DynamicForm.tsx        # Reads fields from Zustand, renders all FormField components
    FormField.tsx          # 5 types: text | number | date | select | checkbox
  lib/
    pdfExtractor.ts        # pdf.js text extraction → {items: RawTextItem[], pages: PageDimensions[]}
    ocrExtractor.ts        # Tesseract.js v7 OCR pipeline (see below)
    fieldDetector.ts       # Heuristic field detection engine (see below)
    clientExtractor.ts     # Orchestrator: tries pdf.js first, falls back to OCR if <5 items
    validation.ts          # Zod v4 schema validation
    utils.ts               # cn() helper
  store/
    formStore.ts           # Zustand store: pdfFile, fields, formValues, activeFieldId, errors
public/
  pdf.worker.min.mjs
  tesseract-worker.min.js
  tesseract-core/          # WASM files
  lang-data/eng.traineddata.gz
```

---

## Current Pipeline

```
User uploads PDF
  │
  ▼
clientExtractor.ts
  ├── pdfExtractor.ts  → pdf.js reads text layer
  │   if items < 5 (scanned PDF):
  └── ocrExtractor.ts  → Tesseract.js renders each page to canvas (2.5×)
                          → PSM.SPARSE_TEXT recognition
                          → returns {items: RawTextItem[], pages}
  │
  ▼
fieldDetector.ts → detectFields(items, pages) → FormField[]
  │
  ▼
Zustand store → DynamicForm renders fields → user fills → Zod validates
```

---

## ocrExtractor.ts — What it does

- Renders each PDF page to a `<canvas>` at 2.5× scale (no preprocessing — raw canvas)
- Runs Tesseract.js v7 with `PSM.SPARSE_TEXT` (best for form layouts)
- Confidence filter: **none** (all words kept, even low confidence, to not miss handwriting)
- 3 console.group logs for debugging:
  - `[OCR] Page N raw text` — full Tesseract output string (check this first when debugging)
  - `[OCR] Page N — N word(s)` — table of all words with confidence + coordinates
  - `[OCR] Page N — N items to field detector` — what actually gets passed downstream

### Known limitation
Tesseract struggles with **blue ballpoint handwriting on printed lines**. This is the main remaining issue.
The recommended next step is replacing Tesseract with a Hugging Face model (see Phase 2 below).

---

## fieldDetector.ts — Detection Strategies

All strategies run in order. `usedIds` prevents duplicate fields.

### Pre-processing
- `cleanText()` — strips table border chars (`│ ─ | + ┌` etc) from all OCR tokens
- `buildRows()` — groups tokens by Y proximity (±18px), merges adjacent words within 35px gap

### Strategy X (runs FIRST) — Digit-box fields
For fields like **CIF ID**, Account Number, Aadhaar, Mobile:
- Tries **sliding windows of 3, 2, 1 tokens** to match known multi-word labels
- `DIGIT_BOX_LABELS` list: `"cif id"`, `"cif no"`, `"account number"`, `"aadhaar"`, `"pan"`, `"mobile number"`, etc.
- Collects consecutive digit/box tokens to the right → concatenates as value
- Creates empty field (forceCreate=true) if boxes are blank

### Strategy A — Inline colon split
`"Account Number: 1234567"` → label=`"Account Number"`, value=`"1234567"`

### Strategy A2 — Known-label prefix split (no colon)
`"First Name John"` → matched against `KNOWN_LABEL_PHRASES` → label=`"First Name"`, value=`"John"`

### Strategy B — Same-row multi-pair
`[Post Office:] [value] [Date:] [value]` — scans ALL label positions in a row, handles:
- Scenario 1: blank text field
- Scenario 2: digit-box sequence
- Scenario 3: checkbox option row (`□ Yes □ No`)

### Strategy E — Standalone checkbox rows
`□ Savings □ Current □ Fixed Deposit` with label on row above → `select` field

### Strategy C — Label above, value below

### Strategy D — Trailing-colon label + next row value

### Key filtering functions
- `isBlankPlaceholder()` — `_____`, `-----`, box-drawing runs → not a value
- `isFormatHint()` — `(DD/MM/YYYY)`, `(Rs.)` → not a value
- `isLikelyLabel()` — ends with `:` OR matches `FORM_LABEL_KEYWORDS` (max 5 words)
- `SKIP_PATTERNS` — blocks section headings, instructions, row counters

### Field types inferred from label
- `date` — date, dob, birth, opening, closing, maturity
- `select` — gender, scheme, type, mode, occupation, category, marital, nationality
- `number` — amount, deposit, installment, income, pin, age, tenure
- `checkbox` — yes/no values, tick marks
- `text` — everything else

---

## Zustand Store — formStore.ts

```typescript
interface FormField {
  id: string
  label: string
  type: 'text' | 'number' | 'date' | 'select' | 'checkbox'
  value: string | boolean
  options?: string[]       // for select
  bbox?: BoundingBox       // {page, x, y, width, height} in natural PDF units
  required: boolean
}

interface FormStore {
  pdfFile: File | null
  pdfUrl: string | null
  fields: FormField[]
  formValues: Record<string, string | boolean>
  activeFieldId: string | null
  errors: Record<string, string>
  extracting: boolean
  // actions: setPdfFile, setFields, setFieldValue, setActiveField, setExtracting, setErrors, resetForm
}
```

---

## Known Issues (to fix on personal PC)

### P0 — Handwriting not reliably detected
Tesseract misreads or misses blue-ink handwritten values on printed form lines.
**Recommended fix**: Replace Tesseract with a Hugging Face model via Transformers.js

### P1 — CIF ID boxes partially detected
OCR sometimes returns CIF and ID as separate tokens with large gap — Strategy X sliding
window should handle this but field still misses in some scan qualities.

---

## Phase 2 Plan — Hugging Face Integration

Replace `ocrExtractor.ts` with a Transformers.js pipeline.

### Recommended models (best first)

1. **`naver-clova-ix/donut-base-finetuned-docvqa`** (BEST for this use case)
   - End-to-end: raw image → text (no separate OCR step)
   - Document Q&A: ask `"What is the CIF ID?"` → returns value
   - Runs fully in browser via `@huggingface/transformers`
   - Model size: ~200MB (downloads once, cached)

2. **`microsoft/layoutlmv3-base`**
   - Takes Tesseract OCR output (text + bboxes) + image → better KV extraction
   - Good for structured forms with spatial layout

3. **`impira/layoutlm-document-qa`**
   - Simple HF Inference API (needs free HF token + outbound HTTPS)

### Integration plan for Donut

```bash
npm install @huggingface/transformers
```

```typescript
// src/lib/donutExtractor.ts
import { pipeline } from '@huggingface/transformers';

const FIELDS_TO_ASK = [
  "What is the CIF ID?",
  "What is the First Name?",
  "What is the Last Name?",
  "What is the Middle Name?",
  "What is the Mobile Number?",
  "What is the PAN Number?",
  "What is the Email ID?",
  "What is the Date of Birth?",
  "What is the Mother's Maiden Name?",
  // ... add all expected fields
];

export async function donutExtractFromImage(imageUrl: string) {
  const qa = await pipeline('document-question-answering', 
    'naver-clova-ix/donut-base-finetuned-docvqa'
  );
  const results = await Promise.all(
    FIELDS_TO_ASK.map(q => qa(imageUrl, q))
  );
  // map results back to FormField[]
}
```

For local asset serving (corporate proxy workaround), download model files and set:
```typescript
env.localModelPath = '/models/donut/';
env.allowRemoteModels = false;
```

---

## How to Run

```bash
cd smartpdfforms
npm install
npm run dev        # starts on http://localhost:3000
```

The dev server must be started from `smartpdfforms/` directory. If using background
terminals in VS Code, specify the CWD explicitly:
```powershell
& "C:\Users\ns185366\smartpdfforms\smartpdfforms\node_modules\.bin\next.cmd" dev --port 3000 "C:\Users\ns185366\smartpdfforms\smartpdfforms"
```

---

## Debugging Tips

1. Open browser DevTools → Console after uploading PDF
2. Look for `[OCR] Page 1 raw text` group (purple) — this is what Tesseract actually saw
3. Look for `[OCR] Page 1 — N word(s)` group (blue) — all detected words with confidence
4. Look for `[SmartPDFForms] Detected fields` — what the field detector produced
5. `[StrategyX] Matched digit-box label "..."` — confirms CIF ID / Account No detection
6. Add `?debugOCR=1` to URL to see a visual overlay of the preprocessed canvas

---

## Corporate Environment Notes

- All Tesseract assets are in `public/` — zero CDN calls at runtime
- The only CDN calls are at install time (`npm install`)
- Hugging Face models must also be downloaded externally and placed in `public/models/`
  if corporate proxy blocks `huggingface.co`
