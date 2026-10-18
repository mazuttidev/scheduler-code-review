import { z } from 'zod';

import { Confidence, CriterionStatus, FindingCategory, Severity, Verdict } from './enums.js';

export const FindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(Severity),
  category: z.enum(FindingCategory),
  file: z.string().min(1),
  /** `null` = o achado vale para o arquivo inteiro. */
  line: z.number().int().positive().nullable(),
  title: z.string().min(1),
  comment: z.string().min(1),
  suggestion: z.string().nullable(),
  confidence: z.enum(Confidence),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CriterionCheckSchema = z.object({
  criterion: z.string().min(1),
  status: z.enum(CriterionStatus),
  notes: z.string(),
});
export type CriterionCheck = z.infer<typeof CriterionCheckSchema>;

/**
 * Conteúdo do review produzido pela IA. Tarefa, MR e `head_sha` não entram
 * aqui: a aplicação já os conhece e os acrescenta no `ReviewReport`.
 */
export const ReviewOutputSchema = z.object({
  summary: z.string().min(1),
  verdict: z.enum(Verdict),
  acceptanceCriteria: z.array(CriterionCheckSchema),
  findings: z.array(FindingSchema),
});
export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

/** JSON Schema entregue ao provedor. O Agent SDK valida em draft-07. */
export function reviewOutputJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ReviewOutputSchema, { target: 'draft-7' });
}
