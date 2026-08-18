import { z } from 'zod';

/**
 * The three rehabilitation disciplines a therapy company staffs inside a facility.
 * They matter to the integration because a contract is scoped per discipline: a company
 * contracted for PT only must not see speech-therapy caseloads at that facility.
 */
export const disciplineSchema = z.enum(['PT', 'OT', 'SLP']);
export type Discipline = z.infer<typeof disciplineSchema>;

export const DISCIPLINE_LABELS: Record<Discipline, string> = {
  PT: 'Physical Therapy',
  OT: 'Occupational Therapy',
  SLP: 'Speech-Language Pathology',
};
