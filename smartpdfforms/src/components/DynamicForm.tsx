"use client";

import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle, AlertCircle } from "lucide-react";
import { useFormStore } from "@/store/formStore";
import { FormField } from "./FormField";
import { validateForm } from "@/lib/validation";
import { useState } from "react";

export function DynamicForm() {
  const fields = useFormStore((s) => s.fields);
  const formValues = useFormStore((s) => s.formValues);
  const activeFieldId = useFormStore((s) => s.activeFieldId);
  const errors = useFormStore((s) => s.errors);
  const extracting = useFormStore((s) => s.extracting);
  const pdfUrl = useFormStore((s) => s.pdfUrl);
  const setFieldValue = useFormStore((s) => s.setFieldValue);
  const setActiveField = useFormStore((s) => s.setActiveField);
  const setErrors = useFormStore((s) => s.setErrors);

  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = () => {
    const validationErrors = validateForm(fields, formValues);

    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      // Scroll to first error
      const firstErrorId = Object.keys(validationErrors)[0];
      setActiveField(firstErrorId);
      return;
    }

    setErrors({});
    setSubmitted(true);
    setTimeout(() => setSubmitted(false), 3000);
  };

  if (fields.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-gray-400 p-8">
        <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
          <span className="text-2xl">📋</span>
        </div>
        {!pdfUrl ? (
          <p className="text-sm font-medium text-center">
            Upload a PDF to see the dynamic form here
          </p>
        ) : extracting ? (
          <p className="text-sm font-medium text-center text-gray-500">Extracting fields…</p>
        ) : (
          <>
            <p className="text-sm font-semibold text-gray-600 text-center">
              No fields detected in this PDF
            </p>
            <p className="text-xs text-gray-400 text-center leading-relaxed">
              This may be a scanned/image-based PDF (no text layer) or an
              unsupported layout. Try a digital typed bank form PDF.
              Check the browser console for extracted raw text.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-white">
        <h2 className="text-sm font-semibold text-gray-800">Extracted Form Fields</h2>
        <p className="text-xs text-gray-400 mt-0.5">{fields.length} fields detected</p>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <AnimatePresence>
          {fields.map((field) => (
            <FormField
              key={field.id}
              field={field}
              value={formValues[field.id] ?? (field.type === "checkbox" ? false : "")}
              error={errors[field.id]}
              isActive={activeFieldId === field.id}
              onChange={(val) => setFieldValue(field.id, val)}
              onFocus={() => setActiveField(field.id)}
              onBlur={() => {/* keep active so PDF stays highlighted */}}
            />
          ))}
        </AnimatePresence>
      </div>

      {/* Submit */}
      <div className="p-4 border-t bg-white">
        <AnimatePresence>
          {submitted && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-green-600 text-sm mb-3 bg-green-50 p-2.5 rounded-lg"
            >
              <CheckCircle className="w-4 h-4" />
              Form submitted successfully!
            </motion.div>
          )}
          {Object.keys(errors).filter((k) => errors[k]).length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2 text-red-600 text-sm mb-3 bg-red-50 p-2.5 rounded-lg"
            >
              <AlertCircle className="w-4 h-4" />
              Please fix the errors above
            </motion.div>
          )}
        </AnimatePresence>

        <button
          onClick={handleSubmit}
          className="w-full py-2.5 px-4 rounded-xl bg-blue-600 hover:bg-blue-700 active:scale-95 text-white text-sm font-semibold transition-all duration-150 shadow-sm"
        >
          Submit Form
        </button>
      </div>
    </div>
  );
}
