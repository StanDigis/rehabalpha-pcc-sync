import {
  localCalendarDate,
  PermanentSyncError,
  type Clock,
  type Facility,
  type FacilityContract,
  type Logger,
  type SyncEntityType,
} from '@rehabalpha/core';
import type { PccApi } from '@rehabalpha/pcc-client';
import type { AuditLog } from '../audit.js';
import type { SyncStore } from '../firestore/store.js';

export type SyncDeps = {
  store: SyncStore;
  pcc: PccApi;
  clock: Clock;
  logger: Logger;
  audit: AuditLog;
};

export type SyncWarning = { code: string; detail: Record<string, unknown> };

export type SyncOutcome = {
  entityType: SyncEntityType;
  entityPccId: string;
  applied: boolean;
  /** Why the sync did or did not write, in the vocabulary the console displays. */
  decision: string;
  documentIds: string[];
  warnings: SyncWarning[];
};

export type ResolvedContext = {
  therapyOrgId: string;
  pccOrgUuid: string;
  facilityId: string;
  pccFacId: string;
  facility: Facility;
  contract: FacilityContract;
  /** Calendar date in the facility's own time zone. */
  today: string;
  source: 'webhook' | 'reconciliation' | 'backfill' | 'operator';
  causedByEventId: string | null;
};

export type ContextRequest = {
  therapyOrgId: string;
  pccOrgUuid: string;
  pccFacId: string;
  source: ResolvedContext['source'];
  causedByEventId: string | null;
};

export type ContextResolution =
  { ok: true; context: ResolvedContext } | { ok: false; skipReason: 'contractInactive' };

/**
 * Establishes that this tenant is allowed to synchronise this facility, right now.
 *
 * The check is not bookkeeping. In contract therapy, the therapy company's right to a facility's
 * patient data comes from an active contract, and when that contract lapses the data stops being
 * theirs to pull — continuing would be accessing PHI without a basis for it, whatever the cached
 * PCC credential still technically permits. Doing the check here, on the one path every sync goes
 * through, is what makes that guarantee hold rather than depend on each caller remembering.
 *
 * An unknown facility is a different situation and is raised as a permanent failure: it means a
 * webhook arrived for something nobody onboarded, which needs an operator, not a retry.
 */
export async function resolveSyncContext(
  deps: SyncDeps,
  request: ContextRequest,
): Promise<ContextResolution> {
  const facility = await deps.store.findFacilityByPcc(
    request.therapyOrgId,
    request.pccOrgUuid,
    request.pccFacId,
  );

  if (facility === null) {
    throw new PermanentSyncError(
      'facility_not_onboarded',
      `No facility mapped to PCC organisation ${request.pccOrgUuid} facility ${request.pccFacId}`,
    );
  }

  const today = localCalendarDate(deps.clock.now(), facility.timeZone);
  const contract = await deps.store.findActiveContract(request.therapyOrgId, facility.id, today);

  if (contract === null) {
    deps.logger.warn('Skipping sync: no active facility contract', {
      facilityId: facility.id,
      today,
    });
    return { ok: false, skipReason: 'contractInactive' };
  }

  return {
    ok: true,
    context: {
      therapyOrgId: request.therapyOrgId,
      pccOrgUuid: request.pccOrgUuid,
      facilityId: facility.id,
      pccFacId: request.pccFacId,
      facility,
      contract,
      today,
      source: request.source,
      causedByEventId: request.causedByEventId,
    },
  };
}

export function skippedOutcome(
  entityType: SyncEntityType,
  entityPccId: string,
  decision: string,
): SyncOutcome {
  return { entityType, entityPccId, applied: false, decision, documentIds: [], warnings: [] };
}

export type { PccApi };
