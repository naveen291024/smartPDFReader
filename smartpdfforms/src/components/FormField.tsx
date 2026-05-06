"use client";

import { motion } from "framer-motion";
import type { FormField as FormFieldType } from "@/store/formStore";
import { cn } from "@/lib/utils";

interface FormFieldProps {
  field: FormFieldType;
  value: string | boolean;
  error?: string;
  isActive: boolean;
  onChange: (value: string | boolean) => void;
  onFocus: () => void;
  onBlur: () => void;
}

const inputBase =
  "w-full rounded-lg border px-3 py-2 text-sm outline-none transition-all duration-200 focus:ring-2 focus:ring-blue-500 focus:border-blue-400 bg-white";

const labelBase = "block text-xs font-semibold text-gray-600 mb-1";

export function FormField({
  field,
  value,
  error,
  isActive,
  onChange,
  onFocus,
  onBlur,
}: FormFieldProps) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "p-3 rounded-xl border transition-all duration-200",
        isActive
          ? "border-blue-400 bg-blue-50/60 shadow-md shadow-blue-100"
          : "border-gray-200 bg-white hover:border-gray-300"
      )}
    >
      <label htmlFor={field.id} className={labelBase}>
        {field.label}
        {field.required && <span className="text-red-400 ml-0.5">*</span>}
      </label>

      {/* TEXT */}
      {field.type === "text" && (
        <input
          id={field.id}
          type="text"
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(inputBase, error ? "border-red-400" : "border-gray-300")}
          placeholder={`Enter ${field.label}`}
        />
      )}

      {/* NUMBER */}
      {field.type === "number" && (
        <input
          id={field.id}
          type="number"
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(inputBase, error ? "border-red-400" : "border-gray-300")}
          placeholder={`Enter ${field.label}`}
        />
      )}

      {/* DATE */}
      {field.type === "date" && (
        <input
          id={field.id}
          type="date"
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(inputBase, error ? "border-red-400" : "border-gray-300")}
        />
      )}

      {/* SELECT */}
      {field.type === "select" && (
        <select
          id={field.id}
          value={value as string}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          className={cn(inputBase, "cursor-pointer", error ? "border-red-400" : "border-gray-300")}
        >
          <option value="">Select…</option>
          {(field.options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      )}

      {/* CHECKBOX */}
      {field.type === "checkbox" && (
        <div className="flex items-center gap-2 mt-1">
          <input
            id={field.id}
            type="checkbox"
            checked={value as boolean}
            onChange={(e) => onChange(e.target.checked)}
            onFocus={onFocus}
            onBlur={onBlur}
            className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
          />
          <span className="text-sm text-gray-700">{value ? "Yes" : "No"}</span>
        </div>
      )}

      {error && (
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="mt-1 text-xs text-red-500"
        >
          {error}
        </motion.p>
      )}
    </motion.div>
  );
}
