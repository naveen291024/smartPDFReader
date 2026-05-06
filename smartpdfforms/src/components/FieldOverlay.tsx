"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { FormField } from "@/store/formStore";

interface FieldOverlayProps {
  fields: FormField[];
  activeFieldId: string | null;
  /** Rendered page dimensions (pixels) so we can scale bounding boxes */
  pageWidth: number;
  pageHeight: number;
  /** Natural (pdf.js point-space) page dimensions */
  naturalWidth: number;
  naturalHeight: number;
  currentPage: number;
}

export function FieldOverlay({
  fields,
  activeFieldId,
  pageWidth,
  pageHeight,
  naturalWidth,
  naturalHeight,
  currentPage,
}: FieldOverlayProps) {
  const scaleX = pageWidth / naturalWidth;
  const scaleY = pageHeight / naturalHeight;

  const pageFields = fields.filter((f) => f.bbox.page === currentPage);

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ width: pageWidth, height: pageHeight }}
    >
      {pageFields.map((field) => {
        const isActive = field.id === activeFieldId;
        const box = {
          left: field.bbox.x * scaleX,
          top: field.bbox.y * scaleY,
          width: field.bbox.width * scaleX,
          height: field.bbox.height * scaleY,
        };

        return (
          <AnimatePresence key={field.id}>
            <motion.div
              key={field.id + isActive}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute rounded"
              style={{
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                border: isActive ? "2px solid #3b82f6" : "1.5px solid #93c5fd",
                backgroundColor: isActive
                  ? "rgba(59,130,246,0.18)"
                  : "rgba(147,197,253,0.10)",
                boxShadow: isActive ? "0 0 0 3px rgba(59,130,246,0.25)" : "none",
                transition: "all 0.2s ease",
              }}
            >
              {isActive && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: -22 }}
                  className="absolute left-0 top-0 text-[10px] font-semibold text-white bg-blue-500 px-1.5 py-0.5 rounded whitespace-nowrap"
                >
                  {field.label}
                </motion.div>
              )}
            </motion.div>
          </AnimatePresence>
        );
      })}
    </div>
  );
}
