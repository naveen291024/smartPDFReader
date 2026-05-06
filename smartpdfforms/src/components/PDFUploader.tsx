"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { motion } from "framer-motion";
import { UploadCloud, FileText } from "lucide-react";
import { useFormStore } from "@/store/formStore";
import { cn } from "@/lib/utils";

interface PDFUploaderProps {
  onUpload: (file: File) => void;
}

export function PDFUploader({ onUpload }: PDFUploaderProps) {
  const pdfFile = useFormStore((s) => s.pdfFile);

  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted[0]) onUpload(accepted[0]);
    },
    [onUpload]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxFiles: 1,
  });

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
    >
    <div
      {...getRootProps()}
      className={cn(
        "flex flex-col items-center justify-center gap-3 p-10 rounded-2xl border-2 border-dashed cursor-pointer transition-colors",
        isDragActive
          ? "border-blue-500 bg-blue-50"
          : "border-gray-300 bg-gray-50 hover:border-blue-400 hover:bg-blue-50/50"
      )}
    >
      <input {...getInputProps()} />

      {pdfFile ? (
        <>
          <FileText className="w-10 h-10 text-blue-500" />
          <p className="text-sm font-medium text-gray-700">{pdfFile.name}</p>
          <p className="text-xs text-gray-400">Drop a new file to replace</p>
        </>
      ) : (
        <>
          <UploadCloud
            className={cn(
              "w-10 h-10 transition-colors",
              isDragActive ? "text-blue-500" : "text-gray-400"
            )}
          />
          <p className="text-sm font-medium text-gray-700">
            {isDragActive ? "Drop the PDF here" : "Drag & drop a bank PDF form"}
          </p>
          <p className="text-xs text-gray-400">or click to browse — PDF only</p>
        </>
      )}
    </div>
    </motion.div>
  );
}
