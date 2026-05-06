/**
 * pdfExtractor.ts
 * Uses pdf.js (pdfjs-dist) to extract text items with their exact x,y positions
 * from each page of a PDF.
 */

export interface RawTextItem {
  text: string;
  x: number;       // points from left
  y: number;       // points from top  (converted: pageHeight - transform[5])
  width: number;
  height: number;
  page: number;
  confidence?: number;  // 0–1, from EasyOCR; low values indicate handwriting
}

export interface PageDimensions {
  page: number;
  width: number;
  height: number;
}

export interface ExtractionResult {
  items: RawTextItem[];
  pages: PageDimensions[];
}

export async function extractTextFromPDF(file: File): Promise<ExtractionResult> {
  // Import pdfjs from react-pdf so we use the SAME instance (same version)
  // This prevents the "API version does not match Worker version" error
  const { pdfjs } = await import("react-pdf");

  // Point worker to the matching worker file served from public/
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

  const items: RawTextItem[] = [];
  const pages: PageDimensions[] = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const textContent = await page.getTextContent();

    pages.push({
      page: pageNum,
      width: viewport.width,
      height: viewport.height,
    });

    for (const item of textContent.items) {
      // Each item has str, transform, width, height properties
      const ti = item as {
        str: string;
        transform: number[];
        width: number;
        height: number;
      };

      if (!ti.str?.trim()) continue;

      // transform = [scaleX, skewX, skewY, scaleY, translateX, translateY]
      const [, , , , tx, ty] = ti.transform;

      items.push({
        text: ti.str.trim(),
        x: tx,
        // PDF y=0 is bottom-left; convert to top-left origin
        y: viewport.height - ty,
        width: ti.width ?? 0,
        height: ti.height ?? 12,
        page: pageNum,
      });
    }
  }

  return { items, pages };
}
