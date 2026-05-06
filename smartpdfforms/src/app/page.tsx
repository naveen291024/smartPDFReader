"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FileSearch, Loader2, AlertTriangle, ScanLine } from "lucide-react";
import dynamic from "next/dynamic";
import { PDFUploader } from "@/components/PDFUploader";
import { DynamicForm } from "@/components/DynamicForm";
import { useFormStore } from "@/store/formStore";
import type { PageDimensions } from "@/lib/pdfExtractor";
import type { OCRProgress } from "@/lib/ocrExtractor";

// Dynamically import PDFViewer with ssr:false — pdfjs uses DOMMatrix which
// is not available in Node.js / Next.js server environment
const PDFViewer = dynamic(
  () => import("@/components/PDFViewer").then((m) => m.PDFViewer),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading PDF viewer…
      </div>
    ),
  }
);

export default function Home() {
  const pdfUrl = useFormStore((s) => s.pdfUrl);
  const setPdfFile = useFormStore((s) => s.setPdfFile);
  const setFields = useFormStore((s) => s.setFields);
  const setExtracting = useFormStore((s) => s.setExtracting);
  const extracting = useFormStore((s) => s.extracting);

  const [error, setError] = useState<string | null>(null);
  const [pageDimensions, setPageDimensions] = useState<PageDimensions[]>([]);
  const [ocrProgress, setOcrProgress] = useState<OCRProgress | null>(null);

  const handleUpload = async (file: File) => {
    setError(null);
    setOcrProgress(null);
    setPdfFile(file);
    setExtracting(true);

    try {
      const { extractFieldsFromPDF } = await import("@/lib/clientExtractor");
      const { fields, pages } = await extractFieldsFromPDF(file, (p) => {
        setOcrProgress(p);
      });
      setPageDimensions(pages);
      setFields(fields);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : "Failed to extract fields from PDF");
    } finally {
      setExtracting(false);
      setOcrProgress(null);
    }
  };

  return (
    <main className="h-screen flex flex-col bg-gray-50">
      {/* Top bar */}
      <header className="flex items-center gap-3 px-6 py-3 bg-white border-b shadow-sm">
        <FileSearch className="w-6 h-6 text-blue-600" />
        <h1 className="text-base font-bold text-gray-900 tracking-tight">
          Smart PDF Forms
        </h1>
        <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
          Phase 1 – PDF.js + OCR
        </span>
      </header>

      {/* Content */}
      <div className="flex-1 flex overflow-hidden">
        <AnimatePresence mode="wait">
          {!pdfUrl ? (
            <motion.div
              key="upload"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex items-center justify-center p-8"
            >
              <div className="w-full max-w-md space-y-4">
                <div className="text-center">
                  <h2 className="text-lg font-semibold text-gray-800">
                    Upload a Bank PDF Form
                  </h2>
                  <p className="text-sm text-gray-500 mt-1">
                    Supports digital PDFs and scanned forms (OCR)
                  </p>
                </div>
                <PDFUploader onUpload={handleUpload} />
                {error && (
                  <div className="flex items-start gap-2 text-red-600 text-sm bg-red-50 p-3 rounded-xl">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                    {error}
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              key="split"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex overflow-hidden"
            >
              {/* Left panel – PDF viewer */}
              <div className="flex-1 flex flex-col border-r overflow-hidden relative">
                {extracting && (
                  <div className="absolute inset-0 z-20 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-4 px-8">
                    {ocrProgress ? (
                      /* OCR progress */
                      <>
                        <ScanLine className="w-9 h-9 text-blue-500 animate-pulse" />
                        <div className="w-full max-w-xs text-center">
                          <p className="text-sm font-semibold text-gray-700 mb-1">
                            OCR — Page {ocrProgress.page} of {ocrProgress.totalPages}
                          </p>
                          <p className="text-xs text-gray-400 mb-3 capitalize">
                            {ocrProgress.status}
                          </p>
                          {/* Progress bar */}
                          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
                            <motion.div
                              className="h-full bg-blue-500 rounded-full"
                              initial={{ width: 0 }}
                              animate={{ width: `${ocrProgress.progress}%` }}
                              transition={{ ease: "linear", duration: 0.3 }}
                            />
                          </div>
                          <p className="text-xs text-gray-400 mt-2">
                            {ocrProgress.progress}% — first run downloads ~10MB language model
                          </p>
                        </div>
                      </>
                    ) : (
                      /* Standard extraction spinner */
                      <>
                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin" />
                        <p className="text-sm font-medium text-gray-700">Extracting fields…</p>
                      </>
                    )}
                  </div>
                )}
                <PDFViewer pdfUrl={pdfUrl} pageDimensions={pageDimensions} />
              </div>

              {/* Right panel – dynamic form */}
              <div className="w-[380px] flex flex-col border-l bg-gray-50 overflow-hidden">
                <DynamicForm />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </main>
  );
}
