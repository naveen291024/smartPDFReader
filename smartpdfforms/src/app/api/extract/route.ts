/**
 * POST /api/extract
 * Accepts a multipart PDF upload, runs pdf.js text extraction
 * + heuristic field detection, returns a JSON field schema.
 */

import { NextRequest, NextResponse } from "next/server";
import { detectFields } from "@/lib/fieldDetector";
import { extractTextFromPDF } from "@/lib/pdfExtractor";

export const runtime = "nodejs";
export const maxDuration = 30;

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

    const { items, pages } = await extractTextFromPDF(file);
    const fields = detectFields(items, pages);

    return NextResponse.json({ fields, pages });
  } catch (err) {
    console.error("[extract] error:", err);
    return NextResponse.json(
      { error: "Failed to process the PDF. Please try a different file." },
      { status: 500 }
    );
  }
}
