/**
 * clientExtractor.ts
 * Orchestrates field extraction:
 *  1. Always sends the PDF to the FastAPI HuggingFace OCR backend via /api/extract
 *  2. FastAPI uses TrOCR (printed + handwritten models) to extract text + bboxes
 *  3. detectFields() runs client-side on the returned RawTextItem[]
 *
 * To fall back to local pdf.js extraction for digital PDFs, set the env var:
 *   NEXT_PUBLIC_FORCE_LOCAL_EXTRACT=true
 */

import { detectFields } from "./fieldDetector";
import type { ExtractionResult } from "./pdfExtractor";
import type { FormField } from "@/store/formStore";
import type { OnProgress } from "./ocrExtractor";

export interface ExtractionOutput {
  fields: FormField[];
  pages: ExtractionResult["pages"];
  usedOCR: boolean;
  modelInfo?: Record<string, string>;
}

export async function extractFieldsFromPDF(
  file: File,
  onOCRProgress?: OnProgress
): Promise<ExtractionOutput> {

  // ── Try pdf.js first for digital PDFs (fast path) ─────────────────────────
  const { extractTextFromPDF } = await import("./pdfExtractor");
  const { items: textItems, pages: pdfPages } = await extractTextFromPDF(file);
  const hasTextLayer = textItems.length > 5;

  if (hasTextLayer) {
    console.log(`[SmartPDFForms] Digital PDF — using pdf.js (${textItems.length} items)`);
    const fields = detectFields(textItems, pdfPages);
    return { fields, pages: pdfPages, usedOCR: false };
  }

  // ── Scanned / mixed PDF — call FastAPI HuggingFace OCR backend ────────────
  console.log("[SmartPDFForms] No text layer — sending to HuggingFace OCR backend…");
  onOCRProgress?.({ page: 1, totalPages: 1, status: "sending to HF OCR backend", progress: 5 });

  const formData = new FormData();
  formData.append("pdf", file, file.name);

  let ocrData: { items: ExtractionResult["items"]; pages: ExtractionResult["pages"]; modelInfo?: Record<string, string> };

  try {
    const res = await fetch("/api/extract", { method: "POST", body: formData });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(error ?? `OCR backend returned ${res.status}`);
    }
    ocrData = await res.json();
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? err.message
        : "Failed to reach OCR backend. Is the FastAPI server running on port 8000? (http://127.0.0.1:8000)"
    );
  }

  onOCRProgress?.({ page: 1, totalPages: 1, status: "processing results", progress: 95 });

  const items = ocrData.items ?? [];
  const pages = ocrData.pages ?? pdfPages;
  const usedOCR = true;

  // Debug: open browser console to see what text was extracted
  console.group(`[SmartPDFForms] ${usedOCR ? "OCR" : "PDF.js"} text extraction`);
  console.log(`Pages: ${pages.length}, Total text items: ${items.length}`);
  console.table(
    items.slice(0, 80).map((i) => ({
      page: i.page,
      text: i.text,
      x: Math.round(i.x),
      y: Math.round(i.y),
      w: Math.round(i.width),
    }))
  );
  console.groupEnd();

  const fields = detectFields(items, pages);

  console.group("[SmartPDFForms] Detected fields");
  console.log(`Fields found: ${fields.length}`);
  console.table(fields.map((f) => ({ id: f.id, label: f.label, type: f.type, value: f.value })));
  console.groupEnd();

  return { fields, pages, usedOCR, modelInfo: ocrData.modelInfo };
}

