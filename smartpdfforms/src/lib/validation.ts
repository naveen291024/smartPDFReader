import { z } from "zod";
import type { FormField } from "@/store/formStore";
import type { FormErrors } from "@/store/formStore";

function buildSchemaForField(field: FormField) {
  switch (field.type) {
    case "number":
      return z
        .string()
        .min(1, `${field.label} is required`)
        .regex(/^\d+(\.\d+)?$/, `${field.label} must be a valid number`);

    case "date":
      return z
        .string()
        .min(1, `${field.label} is required`)
        .regex(/^\d{4}-\d{2}-\d{2}$/, `${field.label} must be a valid date (YYYY-MM-DD)`);

    case "checkbox":
      return z.boolean();

    case "select":
      return z.string().min(1, `Please select ${field.label}`);

    default:
      return z.string().min(1, `${field.label} is required`);
  }
}

export function validateForm(
  fields: FormField[],
  formValues: Record<string, string | boolean>
): FormErrors {
  const errors: FormErrors = {};

  for (const field of fields) {
    if (!field.required) continue;

    const schema = buildSchemaForField(field);
    const result = schema.safeParse(formValues[field.id] ?? "");

    if (!result.success) {
      errors[field.id] = result.error.issues[0]?.message ?? "Invalid value";
    }
  }

  return errors;
}
