import { create } from "zustand";

export type FieldType = "text" | "number" | "checkbox" | "select" | "date";

export interface BoundingBox {
  page: number;       // 1-based page number
  x: number;          // pixels from left on the page
  y: number;          // pixels from top on the page
  width: number;
  height: number;
}

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  value: string | boolean;
  options?: string[];           // for select fields
  bbox: BoundingBox;
  required?: boolean;
  isHandwritten?: boolean;      // true when value was written by hand (low OCR confidence)
  valueConfidence?: number;     // raw OCR confidence for the value token (0–1)
}

export interface FormErrors {
  [fieldId: string]: string;
}

interface FormState {
  // The PDF file the user uploaded
  pdfFile: File | null;
  pdfUrl: string | null;

  // AI/heuristic extracted fields
  fields: FormField[];

  // Live form values keyed by field id
  formValues: Record<string, string | boolean>;

  // Which field is currently focused (drives PDF highlight)
  activeFieldId: string | null;

  // Validation errors
  errors: FormErrors;

  // Loading state while extraction runs
  extracting: boolean;

  // Extraction metadata (populated after each extraction)
  usedOCR: boolean;
  modelInfo: Record<string, string> | null;

  // Actions
  setPdfFile: (file: File) => void;
  setFields: (fields: FormField[]) => void;
  setFieldValue: (id: string, value: string | boolean) => void;
  setActiveField: (id: string | null) => void;
  setExtracting: (value: boolean) => void;
  setErrors: (errors: FormErrors) => void;
  setExtractionMeta: (usedOCR: boolean, modelInfo: Record<string, string> | null) => void;
  resetForm: () => void;
}

export const useFormStore = create<FormState>((set) => ({
  pdfFile: null,
  pdfUrl: null,
  fields: [],
  formValues: {},
  activeFieldId: null,
  errors: {},
  extracting: false,
  usedOCR: false,
  modelInfo: null,

  setPdfFile: (file) =>
    set({
      pdfFile: file,
      pdfUrl: URL.createObjectURL(file),
      fields: [],
      formValues: {},
      activeFieldId: null,
      errors: {},
    }),

  setFields: (fields) => {
    // Pre-populate formValues with extracted values
    const formValues: Record<string, string | boolean> = {};
    fields.forEach((f) => {
      formValues[f.id] = f.value;
    });
    set({ fields, formValues });
  },

  setFieldValue: (id, value) =>
    set((state) => ({
      formValues: { ...state.formValues, [id]: value },
      // Clear error when user edits the field
      errors: { ...state.errors, [id]: "" },
    })),

  setActiveField: (id) => set({ activeFieldId: id }),

  setExtracting: (value) => set({ extracting: value }),

  setErrors: (errors) => set({ errors }),

  setExtractionMeta: (usedOCR, modelInfo) => set({ usedOCR, modelInfo }),

  resetForm: () =>
    set({
      pdfFile: null,
      pdfUrl: null,
      fields: [],
      formValues: {},
      activeFieldId: null,
      errors: {},
      extracting: false,
      usedOCR: false,
      modelInfo: null,
    }),
}));
