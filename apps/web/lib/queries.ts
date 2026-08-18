import type {
  Coverage,
  CoverageRank,
  PersonMatchCandidate,
  SyncCursor,
  SyncDeadLetter,
} from '@rehabalpha/core';
import { compareCoverageRank } from '@rehabalpha/core';
import type { Session } from './auth';
import { DEFAULT_THERAPY_ORG_ID } from './config';
import { getStore } from './store';

export type FacilityLookup = Map<string, string>;

export type SyncHealthRow = SyncCursor & { facilityName: string };

export type DeadLetterRow = SyncDeadLetter & { facilityName: string | null };

export type SanitizedCoverageRow = {
  id: string;
  rank: CoverageRank;
  payerType: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  status: Coverage['status'];
  closureInferred: boolean;
  recordedAt: string;
};

export async function loadFacilityLookup(therapyOrgId: string): Promise<FacilityLookup> {
  const facilities = await getStore().listFacilitiesForOrg(therapyOrgId);
  return new Map(facilities.map((facility) => [facility.id, facility.name]));
}

export async function listSyncHealth(
  therapyOrgId: string = DEFAULT_THERAPY_ORG_ID,
): Promise<SyncHealthRow[]> {
  const store = getStore();
  const [snapshot, facilities] = await Promise.all([
    store.syncCursors().where('therapyOrgId', '==', therapyOrgId).get(),
    loadFacilityLookup(therapyOrgId),
  ]);

  return snapshot.docs
    .map((doc) => doc.data())
    .sort((left, right) => left.facilityId.localeCompare(right.facilityId))
    .map((cursor) => ({
      ...cursor,
      facilityName: facilities.get(cursor.facilityId) ?? cursor.facilityId,
    }));
}

export async function listOpenDeadLetters(
  therapyOrgId: string = DEFAULT_THERAPY_ORG_ID,
): Promise<DeadLetterRow[]> {
  const store = getStore();
  const [snapshot, facilities] = await Promise.all([
    store
      .syncDeadLetters()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('status', 'in', ['open', 'replaying'])
      .get(),
    loadFacilityLookup(therapyOrgId),
  ]);

  return snapshot.docs
    .map((doc) => doc.data())
    .sort(
      (left, right) =>
        right.failure.lastFailedAt.localeCompare(left.failure.lastFailedAt) ||
        left.id.localeCompare(right.id),
    )
    .map((record) => ({
      ...record,
      facilityName:
        record.facilityId === null
          ? null
          : (facilities.get(record.facilityId) ?? record.facilityId),
    }));
}

export async function listPendingIdentityReviews(
  therapyOrgId: string = DEFAULT_THERAPY_ORG_ID,
): Promise<PersonMatchCandidate[]> {
  const snapshot = await getStore()
    .personMatchCandidates()
    .where('therapyOrgId', '==', therapyOrgId)
    .where('status', '==', 'pending')
    .get();

  return snapshot.docs
    .map((doc) => doc.data())
    .sort(
      (left, right) => right.score - left.score || right.createdAt.localeCompare(left.createdAt),
    );
}

export async function loadSanitizedCoverageTimeline(
  patientId: string,
  session: Session,
): Promise<{ patientId: string; rows: SanitizedCoverageRow[] } | null> {
  const store = getStore();
  const patient = await store.getPatient(patientId);
  if (patient === null || patient.therapyOrgId !== session.user.therapyOrgId) {
    return null;
  }

  const coverages = sortCoverageTimeline(
    await store.listCoveragesForPatient(session.user.therapyOrgId, patientId),
  );

  return {
    patientId,
    rows: coverages.map(sanitizeCoverageRow),
  };
}

function sortCoverageTimeline(rows: Coverage[]): Coverage[] {
  return [...rows].sort(
    (left, right) =>
      left.effectiveFrom.localeCompare(right.effectiveFrom) ||
      compareCoverageRank(left.rank, right.rank) ||
      left.recordedAt.localeCompare(right.recordedAt),
  );
}

function sanitizeCoverageRow(coverage: Coverage): SanitizedCoverageRow {
  return {
    id: coverage.id,
    rank: coverage.rank,
    payerType: coverage.payer.payerType.value,
    effectiveFrom: coverage.effectiveFrom,
    effectiveTo: coverage.effectiveTo,
    status: coverage.status,
    closureInferred: coverage.closure?.inferred ?? false,
    recordedAt: coverage.recordedAt,
  };
}

export function formatAge(iso: string | null): string {
  if (iso === null) return '—';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
