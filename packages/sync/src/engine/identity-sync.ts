import {
  documentIds,
  resolveIdentity,
  type AuthoritativeMatch,
  type IdentityCandidate,
  type Patient,
  type Person,
  type PersonLink,
} from '@rehabalpha/core';
import type { ResolvedContext, SyncDeps, SyncOutcome } from './context.js';

/**
 * Attaches a patient projection to the human it belongs to.
 *
 * Runs only when the patient has no link yet. Re-deciding on every demographic edit would send an
 * already-reviewed patient back to the queue every time a clerk fixes a middle initial, and the
 * queue is only useful if everything in it needs a decision.
 *
 * The order of evidence is: PointClickCare's own cross-facility record, then PCC's match endpoint,
 * then an exact match on the facility's medical record number, then a human. Nothing probabilistic
 * is linked automatically. A wrong merge attaches one person's plan of care and payer to another,
 * it surfaces late, and separating two merged charts is far more work than confirming one match.
 */
export async function resolvePatientIdentity(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
): Promise<SyncOutcome> {
  if (patient.personId !== null) {
    return {
      entityType: 'patient',
      entityPccId: patient.pcc.patientId,
      applied: false,
      decision: 'identityAlreadyLinked',
      documentIds: [patient.id],
      warnings: [],
    };
  }

  const authoritative = await findAuthoritativeMatch(deps, context, patient);
  const candidates = authoritative === null ? await loadCandidates(deps, context, patient) : [];

  const outcome = resolveIdentity({
    subject: { demographics: patient.demographics, facilityId: patient.facilityId },
    candidates,
    authoritative,
  });

  if (outcome.decision === 'review') {
    const now = deps.clock.now();
    const batch = deps.store.db.batch();

    for (const candidate of outcome.candidates) {
      const ref = deps.store.personMatchCandidates().doc(`${patient.id}__${candidate.personId}`);
      batch.set(ref, {
        id: ref.id,
        therapyOrgId: context.therapyOrgId,
        facilityId: context.facilityId,
        patientId: patient.id,
        candidatePersonId: candidate.personId,
        score: candidate.score,
        signals: candidate.signals,
        status: 'pending',
        decidedByUid: null,
        decidedAt: null,
        decisionNote: null,
        createdAt: now,
      });
    }

    await batch.commit();

    await deps.audit.record(
      deps.audit.system({
        therapyOrgId: context.therapyOrgId,
        facilityId: context.facilityId,
        action: 'identity.reviewRequested',
        target: { type: 'patient', id: patient.id },
        outcome: 'success',
        correlationId: context.causedByEventId,
        detail: {
          candidateCount: outcome.candidates.length,
          topScore: outcome.candidates[0]?.score ?? null,
        },
      }),
    );

    return {
      entityType: 'patient',
      entityPccId: patient.pcc.patientId,
      applied: false,
      decision: 'identityReviewRequested',
      documentIds: [patient.id],
      warnings: [
        {
          code: 'identity.reviewRequired',
          detail: { candidateCount: outcome.candidates.length },
        },
      ],
    };
  }

  const link: PersonLink =
    outcome.decision === 'link'
      ? {
          method: outcome.method,
          confidence: outcome.confidence,
          status: 'linked',
          decidedAt: deps.clock.now(),
          decidedByUid: null,
        }
      : {
          method: 'deterministicLocal',
          confidence: 1,
          status: 'linked',
          decidedAt: deps.clock.now(),
          decidedByUid: null,
        };

  const personId =
    outcome.decision === 'link'
      ? outcome.personId
      : documentIds.person(context.pccOrgUuid, patient.pcc.patientId);

  await linkPatientToPerson(
    deps,
    context,
    patient,
    personId,
    link,
    outcome.decision === 'createPerson',
  );

  return {
    entityType: 'patient',
    entityPccId: patient.pcc.patientId,
    applied: true,
    decision:
      outcome.decision === 'link' ? `identityLinked.${outcome.method}` : 'identityPersonCreated',
    documentIds: [patient.id, personId],
    warnings: [],
  };
}

/**
 * Asks PCC whether it already knows these facility records are the same human.
 *
 * PCC maintains an organisation master patient record precisely because a resident can appear at
 * several facilities in one organisation, and it has admission-desk evidence we never see. Using it
 * turns the hard case from a scoring problem into a lookup.
 */
async function findAuthoritativeMatch(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
): Promise<AuthoritativeMatch | null> {
  const master = await deps.pcc.getOrganizationMasterPatient(
    context.pccOrgUuid,
    patient.pcc.patientId,
  );
  if (master === null) return null;

  const siblingPccIds = master.patients
    .map((entry) => entry.patientId)
    .filter((pccPatientId) => pccPatientId !== patient.pcc.patientId);

  if (siblingPccIds.length === 0) return null;

  const siblingRefs = siblingPccIds.map((pccPatientId) =>
    deps.store.patients().doc(documentIds.patient(context.pccOrgUuid, pccPatientId)),
  );
  const snapshots = await deps.store.db.getAll(...siblingRefs);

  for (const snapshot of snapshots) {
    const sibling = snapshot.exists ? (snapshot.data() as Patient) : null;
    if (sibling?.personId != null) {
      return { personId: sibling.personId, method: 'pccMasterPatient' };
    }
  }

  return null;
}

async function loadCandidates(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
): Promise<IdentityCandidate[]> {
  const persons = await deps.store.findPersonCandidates(context.therapyOrgId, {
    lastName: patient.demographics.lastName,
    birthDate: patient.demographics.birthDate,
  });

  if (persons.length === 0) return [];

  // Facility history is a matching signal, and it also decides whether comparing medical record
  // numbers is meaningful at all, since an MRN is only unique within the facility that issued it.
  const facilityIdsByPerson = await Promise.all(
    persons.map(async (person) => ({
      person,
      facilityIds: await deps.store.listFacilityIdsForPerson(context.therapyOrgId, person.id),
    })),
  );

  return facilityIdsByPerson.map(({ person, facilityIds }) => ({
    personId: person.id,
    demographics: person.demographics,
    facilityIds,
  }));
}

async function linkPatientToPerson(
  deps: SyncDeps,
  context: ResolvedContext,
  patient: Patient,
  personId: string,
  link: PersonLink,
  createPerson: boolean,
): Promise<void> {
  const now = deps.clock.now();
  const personRef = deps.store.persons().doc(personId);
  const patientRef = deps.store.patients().doc(patient.id);

  const admissionsQuery = deps.store
    .admissions()
    .where('therapyOrgId', '==', context.therapyOrgId)
    .where('patientId', '==', patient.id);

  await deps.store.db.runTransaction(async (tx) => {
    const [personSnapshot, admissionSnapshot] = await Promise.all([
      tx.get(personRef),
      tx.get(admissionsQuery),
    ]);

    const existingPerson = personSnapshot.exists ? (personSnapshot.data() as Person) : null;

    if (existingPerson === null) {
      tx.set(personRef, {
        id: personId,
        therapyOrgId: context.therapyOrgId,
        demographics: patient.demographics,
        demographicsSource: {
          patientId: patient.id,
          pccLastModified: patient.sync.pccLastModified,
        },
        mergedIntoPersonId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies Person);
    } else {
      // Only a fresher upstream record may rewrite the master demographics, so a facility that
      // syncs later cannot resurrect a name that another facility already corrected.
      const incomingWatermark = patient.sync.pccLastModified;
      const currentWatermark = existingPerson.demographicsSource?.pccLastModified ?? null;
      const isFresher =
        incomingWatermark !== null &&
        (currentWatermark === null || incomingWatermark > currentWatermark);

      tx.update(
        personRef,
        isFresher
          ? {
              demographics: patient.demographics,
              demographicsSource: { patientId: patient.id, pccLastModified: incomingWatermark },
              updatedAt: now,
            }
          : { updatedAt: now },
      );
    }

    tx.update(patientRef, { personId, personLink: link });

    // The denormalised pointer on each stay is what lets a therapist read a person's whole history
    // in one query. It has to be filled in when the link is made, not only when a stay is written.
    for (const doc of admissionSnapshot.docs) {
      if (doc.data().personId === personId) continue;
      tx.update(doc.ref, { personId });
    }

    deps.audit.recordIn(
      tx,
      deps.audit.system({
        therapyOrgId: context.therapyOrgId,
        facilityId: context.facilityId,
        action: createPerson ? 'identity.personCreated' : 'identity.linked',
        target: { type: 'patient', id: patient.id },
        outcome: 'success',
        correlationId: context.causedByEventId,
        detail: {
          personId,
          method: link.method,
          confidence: link.confidence,
          propagatedToAdmissions: admissionSnapshot.size,
        },
      }),
    );
  });
}
