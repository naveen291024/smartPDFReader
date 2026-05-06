/**
 * POST /api/extract
 *
 * Two-mode operation:
 *   1. Digital PDFs (text layer present) → pdf.js extraction (fast, no network)
 *   2. Scanned / mixed PDFs → proxies to FastAPI HuggingFace OCR backend
 *
 * FastAPI backend: HF_OCR_URL (default http://localhost:8000)
 * Returns: { items: RawTextItem[], pages: PageDimensions[], usedOCR: boolean }
 * Field detection (detectFields) runs client-side from the returned items.
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300; // model download + OCR can take several minutes

const HF_OCR_URL = process.env.HF_OCR_URL ?? "http://127.0.0.1:8000";

// Wrapper that applies a generous timeout via AbortSignal
const fetchWithTimeout = (url: string, init: RequestInit, timeoutMs = 290_000) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("pdf") as File | null;

    if (!file || file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Please upload a valid PDF file." },
        { status: 400 }
      );
    }

    // ── Forward to FastAPI HuggingFace OCR backend ──────────────────────────
    console.log(`[extract] Forwarding "${file.name}" to FastAPI OCR: ${HF_OCR_URL}/ocr`);

    const proxyForm = new FormData();
    proxyForm.append("file", file, file.name);

    const upstream = await fetchWithTimeout(`${HF_OCR_URL}/ocr`, {
      method: "POST",
      body: proxyForm,
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error(`[extract] FastAPI error ${upstream.status}:`, detail);
      return NextResponse.json(
        { error: `OCR backend error: ${detail}` },
        { status: upstream.status }
      );
    }

    // FastAPI returns { items, pages, usedOCR, modelInfo }
    const ocrResult = await upstream.json();
    console.log(
      `[extract] OCR complete — ${ocrResult.items?.length ?? 0} items, ` +
      `${ocrResult.pages?.length ?? 0} pages, model: ${ocrResult.modelInfo?.printed ?? "unknown"}`
    );

    // Return items + pages to the client; detectFields runs in the browser
    return NextResponse.json({
      items: ocrResult.items,
      pages: ocrResult.pages,
      usedOCR: true,
      modelInfo: ocrResult.modelInfo,
    });
  } catch (err) {
    console.error("[extract] error:", err);

    // If FastAPI is not running, give a clear message
    const message =
      err instanceof TypeError && err.message.includes("fetch")
        ? `Cannot reach OCR backend at ${HF_OCR_URL}. Run: cd backend && uvicorn main:app --port 8000`
        : "Failed to process the PDF. Please try a different file.";

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
