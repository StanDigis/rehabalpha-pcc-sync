import { z } from 'zod';
import { isoDateTime } from '../schema-primitives.js';

export const syncSourceSchema = z.enum([
  /** Applied because a PCC webhook told us something changed. */
  'webhook',
  /** Applied by the scheduled reconciliation sweep, i.e. we found drift ourselves. */
  'reconciliation',
  /** Applied by the initial census backfill when a facility is first connected. */
  'backfill',
  /** Applied by an operator through the console, always audited with a reason. */
  'operator',
]);
export type SyncSource = z.infer<typeof syncSourceSchema>;

/**
 * Provenance carried by every synchronised document.
 *
 * `pccLastModified` is the load-bearing field. PCC delivers webhooks at least once and with
 * no ordering guarantee, so a naive "fetch and overwrite" lets a slow delivery of an old
 * change clobber a newer one. Storing the upstream modification instant and refusing to
 * apply anything at or below it makes duplicate and out-of-order delivery harmless without
 * needing global event ordering, which is the expensive thing to buy.
 *
 * `contentHash` exists so that a reconciliation sweep over 40 facilities does not rewrite
 * every unchanged document, which would cost writes and pollute the audit trail.
 */
export const syncMetadataSchema = z.object({
  source: syncSourceSchema,
  /** Upstream watermark. Null only for records PCC has never asserted a timestamp for. */
  pccLastModified: isoDateTime.nullable(),
  syncedAt: isoDateTime,
  /** Increments on every accepted write, giving operators a cheap "did this change" signal. */
  syncVersion: z.number().int().nonnegative(),
  /** PCC webhook message id that caused this state, for end-to-end tracing. */
  causedByEventId: z.string().nullable(),
  /** Stable hash of the synchronised fields, used to suppress no-op writes. */
  contentHash: z.string(),
});
export type SyncMetadata = z.infer<typeof syncMetadataSchema>;
