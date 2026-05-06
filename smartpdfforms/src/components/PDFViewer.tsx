"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from "lucide-react";
import { FieldOverlay } from "./FieldOverlay";
import { useFormStore } from "@/store/formStore";
import type { PageDimensions } from "@/lib/pdfExtractor";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

interface PDFViewerProps {
  pdfUrl: string;
  pageDimensions: PageDimensions[];
}

export function PDFViewer({ pdfUrl, pageDimensions }: PDFViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [renderedSize, setRenderedSize] = useState({ width: 0, height: 0 });

  const pageRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fields = useFormStore((s) => s.fields);
  const activeFieldId = useFormStore((s) => s.activeFieldId);

  // When active field changes, jump to its page and scroll to it
  useEffect(() => {
    if (!activeFieldId) return;
    const field = fields.find((f) => f.id === activeFieldId);
    if (!field) return;

    if (field.bbox.page !== currentPage) {
      setCurrentPage(field.bbox.page);
    }

    // Scroll overlay area into view after a tick (page may need to render)
    setTimeout(() => {
      if (!containerRef.current) return;
      const pageDim = pageDimensions.find((p) => p.page === field.bbox.page);
      if (!pageDim) return;
      const scaleX = renderedSize.width / pageDim.width;
      const scaleY = renderedSize.height / pageDim.height;
      const targetY = field.bbox.y * scaleY;
      containerRef.current.scrollTo({ top: targetY - 80, behavior: "smooth" });
    }, 120);
  }, [activeFieldId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDocumentLoad = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
  };

  const onPageRender = useCallback(() => {
    if (!pageRef.current) return;
    const canvas = pageRef.current.querySelector("canvas");
    if (canvas) {
      setRenderedSize({ width: canvas.width, height: canvas.height });
    }
  }, []);

  const naturalDim = pageDimensions.find((p) => p.page === currentPage) ?? {
    width: 595,
    height: 842,
    page: currentPage,
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-white z-10">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage <= 1}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-sm text-gray-600 min-w-[80px] text-center">
            {currentPage} / {numPages}
          </span>
          <button
            onClick={() => setCurrentPage((p) => Math.min(numPages, p + 1))}
            disabled={currentPage >= numPages}
            className="p-1.5 rounded hover:bg-gray-100 disabled:opacity-30"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setScale((s) => Math.max(0.5, s - 0.1))}
            className="p-1.5 rounded hover:bg-gray-100"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-500 w-10 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={() => setScale((s) => Math.min(3, s + 0.1))}
            className="p-1.5 rounded hover:bg-gray-100"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* PDF Canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-100 flex justify-center p-4"
      >
        <Document
          file={pdfUrl}
          onLoadSuccess={onDocumentLoad}
          loading={
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm">
              Loading PDF…
            </div>
          }
        >
          <div className="relative inline-block shadow-xl" ref={pageRef}>
            <Page
              pageNumber={currentPage}
              scale={scale}
              onRenderSuccess={onPageRender}
              renderAnnotationLayer={true}
              renderTextLayer={true}
            />
            {renderedSize.width > 0 && (
              <FieldOverlay
                fields={fields}
                activeFieldId={activeFieldId}
                pageWidth={renderedSize.width}
                pageHeight={renderedSize.height}
                naturalWidth={naturalDim.width}
                naturalHeight={naturalDim.height}
                currentPage={currentPage}
              />
            )}
          </div>
        </Document>
      </div>
    </div>
  );
}
