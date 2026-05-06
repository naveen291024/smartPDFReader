/**
 * clientExtractor.ts
 * Orchestrates field extraction:
 *  - Digital PDFs  → pdf.js text extraction (instant)
 *  - Scanned PDFs  → Tesseract.js OCR fallback (in-browser, no API needed)
 */

import { detectFields } from "./fieldDetector";
import type { ExtractionResult } from "./pdfExtractor";
import type { FormField } from "@/store/formStore";
import type { OnProgress } from "./ocrExtractor";

export interface ExtractionOutput {
  fields: FormField[];
  pages: ExtractionResult["pages"];
  usedOCR: boolean;
}

export async function extractFieldsFromPDF(
  file: File,
  onOCRProgress?: OnProgress
): Promise<ExtractionOutput> {
  const { extractTextFromPDF } = await import("./pdfExtractor");
  const { items: textItems, pages } = await extractTextFromPDF(file);

  const hasTextLayer = textItems.length > 5; // fewer than 5 items = likely scanned

  let items = textItems;
  let usedOCR = false;

  if (!hasTextLayer) {
    console.log("[SmartPDFForms] No text layer detected — switching to Tesseract.js OCR");
    const { ocrExtractFromPDF } = await import("./ocrExtractor");
    const ocrResult = await ocrExtractFromPDF(file, onOCRProgress);
    items = ocrResult.items;
    // Use OCR pages if pdf.js returned none
    if (pages.length === 0) pages.push(...ocrResult.pages);
    usedOCR = true;
  }

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

  return { fields, pages, usedOCR };
}

