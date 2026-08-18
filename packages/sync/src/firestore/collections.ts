import { PermanentSyncError, pseudonymise } from '@rehabalpha/core';
import type {
  DocumentData,
  Firestore,
  FirestoreDataConverter,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import type { z } from 'zod';

/**
 * Top-level collections with a denormalised `therapyOrgId` on every document, rather than nesting
 * everything under `therapyOrgs/{id}/…`.
 *
 * Nesting reads better and is the obvious first instinct, but the access patterns argue against
 * it. The console needs cross-facility queries within a tenant ("every open dead letter",
 * "everything awaiting identity review"), which under a nested layout means collection-group
 * queries — and a collection-group query cannot be constrained to a single tenant by its path, so
 * tenant isolation would rest entirely on a `where` clause that a future caller can forget.
 *
 * With a flat layout plus an explicit tenant field, the same field that scopes the query is the
 * field the security rules check, and both are visible in one line. The cost is one redundant
 * field per document and the discipline of always setting it, which the schemas enforce.
 */
export const COLLECTIONS = {
  therapyOrgs: 'therapyOrgs',
  facilities: 'facilities',
  facilityContracts: 'facilityContracts',
  pccConnections: 'pccConnections',

  persons: 'persons',
  patients: 'patients',
  admissions: 'admissions',
  coverages: 'coverages',
  personMatchCandidates: 'personMatchCandidates',

  syncEvents: 'syncEvents',
  syncCursors: 'syncCursors',
  syncDeadLetters: 'syncDeadLetters',
  reconciliationRuns: 'reconciliationRuns',
  driftRecords: 'driftRecords',

  auditEvents: 'auditEvents',
  userGrants: 'userGrants',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

/**
 * Validates on read as well as on write.
 *
 * Reading is where the value is, and it is the half usually skipped. A document written by an
 * older deploy, a half-finished migration or a well-meaning manual edit in the console is
 * otherwise trusted implicitly, and the failure surfaces somewhere far from the cause — a
 * `undefined is not an object` in a React component, say. Failing at the boundary names the
 * document and the field.
 */
export function zodConverter<T extends Record<string, unknown>>(
  schema: z.ZodType<T>,
  label: string,
): FirestoreDataConverter<T> {
  return {
    toFirestore(model): DocumentData {
      return model as DocumentData;
    },
    fromFirestore(snapshot: QueryDocumentSnapshot): T {
      const parsed = schema.safeParse(snapshot.data());
      if (!parsed.success) {
        const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
        // The document id embeds the upstream patient identifier, so it is pseudonymised here:
        // an operator can still correlate it with the log line that produced it.
        throw new PermanentSyncError(
          'stored_document_invalid',
          `Stored ${label} document ${pseudonymise(snapshot.id)} failed validation on: ${fields}`,
        );
      }
      return parsed.data;
    },
  };
}

/**
 * Firestore permits at most 30 values in an `in` or `array-contains-any` clause.
 *
 * The constraint is worth naming in code because the alternative to respecting it is the query
 * pattern this integration exists to avoid: a loop that reads coverage one patient at a time.
 * On a 90-bed facility that is 90 round trips to render one screen, and it is the kind of thing
 * that passes review because each individual line looks fine.
 */
export const MAX_IN_CLAUSE_VALUES = 30;

export function chunk<T>(values: readonly T[], size = MAX_IN_CLAUSE_VALUES): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export type Db = Firestore;
