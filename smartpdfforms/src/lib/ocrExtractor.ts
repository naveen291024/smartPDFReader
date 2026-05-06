/**
 * ocrExtractor.ts — minimal, no preprocessing, passes raw canvas to Tesseract.
 */

import type { RawTextItem, PageDimensions } from "./pdfExtractor";

export interface OCRProgress {
  page: number;
  totalPages: number;
  status: string;
  progress: number; // 0-100
}

export type OnProgress = (p: OCRProgress) => void;

const OCR_SCALE = 2.5;

async function renderPageToCanvas(
  pdfDoc: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  pageNum: number
): Promise<{ canvas: HTMLCanvasElement; scaleUsed: number; naturalWidth: number; naturalHeight: number }> {
  const page = await pdfDoc.getPage(pageNum);
  const naturalVp = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width  = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  // No preprocessing — raw canvas sent directly to Tesseract
  return { canvas, scaleUsed: OCR_SCALE, naturalWidth: naturalVp.width, naturalHeight: naturalVp.height };
}

export async function ocrExtractFromPDF(
  file: File,
  onProgress?: OnProgress
): Promise<{ items: RawTextItem[]; pages: PageDimensions[] }> {
  const { pdfjs } = await import("react-pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const { createWorker, PSM } = await import("tesseract.js");

  const arrayBuffer = await file.arrayBuffer();
  const pdfDoc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const totalPages = pdfDoc.numPages;

  const items: RawTextItem[] = [];
  const pages: PageDimensions[] = [];

  onProgress?.({ page: 1, totalPages, status: "loading OCR engine", progress: 0 });

  const worker = await createWorker("eng", 1, {
    workerPath: "/tesseract-worker.min.js",
    corePath: "/tesseract-core/",
    langPath: "/lang-data",
    logger: (m: { status: string; progress: number }) => {
      if (m.status === "recognizing text") {
        onProgress?.({ page: 1, totalPages, status: "recognizing text", progress: Math.round(5 + m.progress * 90) });
      } else if (m.status?.includes("loading")) {
        onProgress?.({ page: 1, totalPages, status: m.status, progress: 2 });
      }
    },
  });

  await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });

  type TWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    onProgress?.({ page: pageNum, totalPages, status: "rendering page", progress: 5 });

    const { canvas, scaleUsed, naturalWidth, naturalHeight } = await renderPageToCanvas(pdfDoc, pageNum);
    pages.push({ page: pageNum, width: naturalWidth, height: naturalHeight });

    onProgress?.({ page: pageNum, totalPages, status: "recognizing text", progress: 10 });

    let result;
    try {
      result = await worker.recognize(canvas);
    } catch (err) {
      console.error(`[OCR] Failed on page ${pageNum}:`, err);
      continue;
    }

    const data = result.data as unknown as Record<string, unknown>;

    console.group(`%c[OCR] Page ${pageNum} raw text`, "color:#8b5cf6;font-weight:bold");
    console.log(data.text as string ?? "(empty)");
    console.groupEnd();

    let words: TWord[] = [];
    if (Array.isArray(data.words) && (data.words as TWord[]).length > 0) {
      words = data.words as TWord[];
    } else if (Array.isArray(data.lines)) {
      for (const line of data.lines as { words: TWord[] }[])
        if (Array.isArray(line.words)) words.push(...line.words);
    } else if (Array.isArray(data.blocks)) {
      for (const block of data.blocks as { paragraphs: { lines: { words: TWord[] }[] }[] }[])
        for (const para of block.paragraphs ?? [])
          for (const line of para.lines ?? [])
            if (Array.isArray(line.words)) words.push(...line.words);
    }

    console.group(`%c[OCR] Page ${pageNum} — ${words.length} word(s)`, "color:#0ea5e9;font-weight:bold");
    if (words.length > 0) {
      console.table(words.map((w) => ({ text: w.text, conf: w.confidence, x0: Math.round(w.bbox.x0 / scaleUsed), y0: Math.round(w.bbox.y0 / scaleUsed) })));
    } else {
      console.warn("No word-level data. Falling back to raw text.");
    }
    console.groupEnd();

    if (words.length === 0 && typeof data.text === "string") {
      const textLines = (data.text as string).split("\n").map((l: string) => l.trim()).filter(Boolean);
      const lineHeight = naturalHeight / Math.max(textLines.length, 1);
      textLines.forEach((lineText: string, i: number) => {
        lineText.split(/\s+/).filter(Boolean).forEach((word: string) => {
          items.push({ text: word, x: 50, y: i * lineHeight + lineHeight * 0.2, width: word.length * 6, height: lineHeight * 0.6, page: pageNum });
        });
      });
      continue;
    }

    const before = items.length;
    for (const word of words) {
      if (!word.text?.trim()) continue; // no confidence filter — keep everything
      const x = word.bbox.x0 / scaleUsed;
      const y = word.bbox.y0 / scaleUsed;
      const w = (word.bbox.x1 - word.bbox.x0) / scaleUsed;
      const h = (word.bbox.y1 - word.bbox.y0) / scaleUsed;
      items.push({ text: word.text.trim(), x, y, width: w, height: h, page: pageNum });
    }

    console.group(`%c[OCR] Page ${pageNum} — ${items.length - before} items to field detector`, "color:#10b981;font-weight:bold");
    console.table(items.slice(before).map((it) => ({ text: it.text, x: Math.round(it.x), y: Math.round(it.y) })));
    console.groupEnd();

    onProgress?.({ page: pageNum, totalPages, status: "done", progress: 100 });
  }

  await worker.terminate();
  return { items, pages };
}
