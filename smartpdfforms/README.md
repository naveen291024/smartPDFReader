# SmartPDFForms

An intelligent PDF form reader that automatically extracts fields from scanned or digital PDF forms, overlays interactive bounding boxes on the original document, and presents a validated, editable form — all in the browser.

Originally built for **India Post / Post Office account opening forms**, it works with any structured PDF form.

---

## Features

- **Drag-and-drop PDF upload** — accepts digital and scanned PDFs
- **Dual extraction pipeline**
  - Digital PDFs → fast client-side text extraction via `pdf.js` (no backend call)
  - Scanned / handwritten PDFs → server-side HuggingFace OCR (EasyOCR + TrOCR)
- **Intelligent field detection** — multi-strategy heuristic engine detects labels, values, dates, checkboxes, select fields, and digit-box sequences (CIF ID, Aadhaar, PAN, Mobile, etc.)
- **Split-panel UI** — left: PDF viewer with animated bounding-box overlays; right: auto-populated editable form
- **Field type inference** — automatically classifies fields as `text`, `number`, `date`, `select`, or `checkbox` from label keywords
- **Zod form validation** — submit triggers full schema validation with inline error messages
- **Fully offline-capable** — all OCR workers, WASM binaries, and language data are served locally; no CDN calls at runtime

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       Browser (Next.js)                      │
│                                                              │
│  PDFUploader ──► clientExtractor.ts                          │
│                      ├─ pdfExtractor.ts  (pdf.js, fast)      │
│                      └─ POST /api/extract ──────────────┐    │
│                                                         │    │
│  fieldDetector.ts ──► Zustand store                     │    │
│                                                         │    │
│  PDFViewer + FieldOverlay     DynamicForm + Zod         │    │
└─────────────────────────────────────────────────────────┼────┘
                                                          │ HTTP POST
                                                ┌─────────▼──────────────┐
                                                │   FastAPI Backend       │
                                                │   Python / port 8000    │
                                                │                         │
                                                │  pdf2image  (300 DPI)   │
                                                │  EasyOCR    (bbox)      │
                                                │  TrOCR printed          │
                                                │  TrOCR handwritten      │
                                                └─────────────────────────┘
```

---

## Tech Stack

### Frontend
| Package | Version | Purpose |
|---|---|---|
| Next.js | 15 (App Router) | Framework, TypeScript, Turbopack |
| react-pdf | 10.x | PDF rendering in browser |
| pdfjs-dist | (bundled) | PDF text-layer extraction |
| zustand | ^4 | Global state management |
| zod | ^4 | Form schema validation |
| framer-motion | ^11 | Animated bounding-box overlays |
| react-dropzone | ^14 | Drag-and-drop file upload |
| tailwindcss | v4 | Styling |
| lucide-react | latest | Icons |

### Backend
| Package | Purpose |
|---|---|
| FastAPI + uvicorn | REST API server |
| EasyOCR | Bounding-box detection |
| `microsoft/trocr-base-printed` | Printed text recognition (HuggingFace TrOCR) |
| `microsoft/trocr-base-handwritten` | Handwritten text recognition (HuggingFace TrOCR) |
| pdf2image | PDF → PIL image conversion at 300 DPI |
| Pillow | Image pre-processing |
| PyTorch | Model inference (CPU or CUDA) |

---

## Project Structure

```
smartpdfforms/
├── backend/
│   ├── main.py              # FastAPI server — EasyOCR + TrOCR OCR pipeline
│   └── requirements.txt     # Python dependencies
├── src/
│   ├── app/
│   │   ├── page.tsx         # Main split-panel page, upload handler, progress bar
│   │   ├── layout.tsx
│   │   ├── globals.css
│   │   └── api/extract/
│   │       └── route.ts     # Next.js API route — proxies PDF to FastAPI backend
│   ├── components/
│   │   ├── PDFUploader.tsx  # Drag-and-drop upload component
│   │   ├── PDFViewer.tsx    # PDF viewer with bounding-box overlays (SSR disabled)
│   │   ├── FieldOverlay.tsx # Framer-motion animated field highlight boxes
│   │   ├── DynamicForm.tsx  # Auto-generated form from detected fields
│   │   └── FormField.tsx    # Renders text / number / date / select / checkbox
│   ├── lib/
│   │   ├── clientExtractor.ts   # Orchestrator: pdf.js fast-path → OCR fallback
│   │   ├── pdfExtractor.ts      # pdf.js text-layer extraction
│   │   ├── ocrExtractor.ts      # Tesseract.js pipeline (legacy in-browser fallback)
│   │   ├── fieldDetector.ts     # Multi-strategy heuristic field detection engine
│   │   ├── validation.ts        # Zod schema
│   │   └── utils.ts
│   └── store/
│       └── formStore.ts     # Zustand store (fields, formValues, activeFieldId, errors)
└── public/
    ├── pdf.worker.min.mjs   # pdf.js worker (local, matches react-pdf's bundled pdfjs)
    ├── tesseract-worker.min.js
    ├── tesseract-core/      # Tesseract WASM binaries
    └── lang-data/           # eng.traineddata language model (local, no CDN)
```

---

## Prerequisites

- **Node.js** 18+
- **Python** 3.9+
- **Poppler** — required by `pdf2image` for PDF-to-image conversion
  - **Windows:** Download from https://github.com/oschwartz10612/poppler-windows/releases → extract and add the `bin/` folder to your system `PATH`
  - **Linux:** `sudo apt install poppler-utils`
  - **macOS:** `brew install poppler`

---

## Setup & Running

### 1. Install frontend dependencies

```bash
cd smartpdfforms
npm install
```

### 2. Install backend dependencies

```bash
cd backend
pip install -r requirements.txt
```

> **Note:** On first run, TrOCR models (~300 MB each) are downloaded from HuggingFace and cached locally. Subsequent runs are instant.

### 3. Start the FastAPI OCR backend

**Windows (PowerShell) — recommended:**
```powershell
Start-Process python `
  -ArgumentList "-m uvicorn main:app --host 127.0.0.1 --port 8000" `
  -WorkingDirectory ".\backend" `
  -WindowStyle Normal
```

**Linux / macOS:**
```bash
cd backend && python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

Verify the backend is running:
```bash
curl http://127.0.0.1:8000/health
# → {"status":"ok","device":"cpu","printed_model":"microsoft/trocr-base-printed",...}
```

Interactive API docs: http://127.0.0.1:8000/docs

> **Important (Windows):** Always use `127.0.0.1` — not `localhost`. On Windows, Node.js resolves `localhost` to `::1` (IPv6) but the FastAPI server only binds on IPv4, causing connection failures.

### 4. Start the Next.js frontend

```bash
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## How It Works

1. **Upload a PDF** via drag-and-drop or file picker
2. **Digital PDF** (text layer detected) → `pdf.js` extracts text client-side instantly — no backend call
3. **Scanned PDF** (no text layer) → PDF is POSTed to `/api/extract`, which forwards it to FastAPI:
   - `pdf2image` converts each page to a PIL image at 300 DPI
   - `EasyOCR` detects bounding boxes for every text region
   - `TrOCR printed model` reads high-confidence regions; `TrOCR handwritten model` handles uncertain ones
   - Returns `{ items, pages, modelInfo }` to the browser
4. **`fieldDetector.ts`** runs multi-strategy heuristics on the text items:
   - **Strategy X** — digit-box fields (CIF ID, Account No, Aadhaar, PAN, Mobile)
   - **Strategy A** — inline colon split (`"Name: John"`)
   - **Strategy A2** — known-label prefix matching
   - **Strategy B** — same-row multi-pair labels and checkboxes
   - **Strategy C/D** — label above / below value
   - **Strategy E** — standalone checkbox option rows
5. **Split panel** renders: PDF with glowing overlay boxes on detected fields + editable form on the right
6. **Click any form field** → the corresponding region on the PDF highlights
7. **Submit** to validate all fields with Zod schema

---

## Environment Variables

Create a `.env.local` file in the project root to override defaults:

```env
# Use 127.0.0.1, not localhost, on Windows (IPv6 mismatch)
HF_OCR_URL=http://127.0.0.1:8000
```

Backend environment variables (set before starting uvicorn):

| Variable | Default | Description |
|---|---|---|
| `HF_PRINTED_MODEL` | `microsoft/trocr-base-printed` | HuggingFace model for printed text |
| `HF_HANDWRITTEN_MODEL` | `microsoft/trocr-base-handwritten` | HuggingFace model for handwriting |
| `PDF_DPI` | `300` | Resolution for PDF-to-image conversion |

---

## API Reference

### `POST /ocr` — FastAPI backend

Accepts a PDF, returns extracted text items and page dimensions.

**Request:** `multipart/form-data` with field `file` (PDF)

**Response:**
```json
{
  "items": [
    {
      "text": "Account Number",
      "page": 1,
      "x": 50, "y": 120,
      "width": 140, "height": 18,
      "confidence": 0.97
    }
  ],
  "pages": [{ "width": 595, "height": 842 }],
  "usedOCR": true,
  "modelInfo": {
    "printed": "microsoft/trocr-base-printed",
    "handwritten": "microsoft/trocr-base-handwritten"
  }
}
```

### `GET /health` — FastAPI backend

Returns server status, device (CPU/GPU), and loaded model names.

### `POST /api/extract` — Next.js proxy

Browser-facing route that forwards the PDF to FastAPI and returns the same JSON. Applies a 5-minute timeout for large documents.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Cannot reach OCR backend` | Start FastAPI with `--host 127.0.0.1` and set `HF_OCR_URL=http://127.0.0.1:8000` in `.env.local` |
| `Error loading ASGI app` | Uvicorn must be started from the `backend/` directory, not the project root |
| Port 8000 already in use | `netstat -ano \| findstr :8000` → `Stop-Process -Id <PID> -Force` |
| No fields detected | Open DevTools → Console → check `[SmartPDFForms]` and `[OCR]` log groups |
| TrOCR models slow first run | First run downloads ~300 MB of models; subsequent runs use the HuggingFace local cache |
| `poppler not found` | Install Poppler and add its `bin/` folder to your system PATH |
| PDF renders blank | Ensure `public/pdf.worker.min.mjs` matches the version bundled inside `node_modules/react-pdf` |

