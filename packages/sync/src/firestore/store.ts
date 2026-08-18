import {
  admissionSchema,
  auditEventSchema,
  coverageSchema,
  driftRecordSchema,
  facilityContractSchema,
  facilitySchema,
  isContractActiveOn,
  patientSchema,
  pccConnectionSchema,
  personMatchCandidateSchema,
  personSchema,
  reconciliationRunSchema,
  syncCursorSchema,
  syncDeadLetterSchema,
  syncEventSchema,
  therapyOrgSchema,
  userGrantSchema,
  type Admission,
  type Coverage,
  type Facility,
  type FacilityContract,
  type Patient,
  type PccConnection,
  type Person,
  type SyncCursor,
  type SyncEntityType,
} from '@rehabalpha/core';
import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';
import { chunk, COLLECTIONS, zodConverter } from './collections.js';

/**
 * Typed access to Firestore.
 *
 * There is deliberately no in-memory implementation of this behind an interface. The behaviour
 * that matters here *is* Firestore behaviour: transaction contention, the thirty-value ceiling on
 * an `in` clause, whether a composite index exists, how a converter handles a document written by
 * an older schema. A hand-written fake agrees with whatever the author believed, which is exactly
 * the belief a test should be checking. The emulator is fast enough that there is no reason to
 * trade accuracy for it.
 */
export class SyncStore {
  constructor(readonly db: Firestore) {}

  readonly therapyOrgs = () =>
    this.db
      .collection(COLLECTIONS.therapyOrgs)
      .withConverter(zodConverter(therapyOrgSchema, 'therapyOrg'));

  readonly facilities = () =>
    this.db
      .collection(COLLECTIONS.facilities)
      .withConverter(zodConverter(facilitySchema, 'facility'));

  readonly facilityContracts = () =>
    this.db
      .collection(COLLECTIONS.facilityContracts)
      .withConverter(zodConverter(facilityContractSchema, 'facilityContract'));

  readonly pccConnections = () =>
    this.db
      .collection(COLLECTIONS.pccConnections)
      .withConverter(zodConverter(pccConnectionSchema, 'pccConnection'));

  readonly persons = () =>
    this.db.collection(COLLECTIONS.persons).withConverter(zodConverter(personSchema, 'person'));

  readonly patients = () =>
    this.db.collection(COLLECTIONS.patients).withConverter(zodConverter(patientSchema, 'patient'));

  readonly admissions = () =>
    this.db
      .collection(COLLECTIONS.admissions)
      .withConverter(zodConverter(admissionSchema, 'admission'));

  readonly coverages = () =>
    this.db
      .collection(COLLECTIONS.coverages)
      .withConverter(zodConverter(coverageSchema, 'coverage'));

  readonly personMatchCandidates = () =>
    this.db
      .collection(COLLECTIONS.personMatchCandidates)
      .withConverter(zodConverter(personMatchCandidateSchema, 'personMatchCandidate'));

  readonly syncEvents = () =>
    this.db
      .collection(COLLECTIONS.syncEvents)
      .withConverter(zodConverter(syncEventSchema, 'syncEvent'));

  readonly syncCursors = () =>
    this.db
      .collection(COLLECTIONS.syncCursors)
      .withConverter(zodConverter(syncCursorSchema, 'syncCursor'));

  readonly syncDeadLetters = () =>
    this.db
      .collection(COLLECTIONS.syncDeadLetters)
      .withConverter(zodConverter(syncDeadLetterSchema, 'syncDeadLetter'));

  readonly reconciliationRuns = () =>
    this.db
      .collection(COLLECTIONS.reconciliationRuns)
      .withConverter(zodConverter(reconciliationRunSchema, 'reconciliationRun'));

  readonly driftRecords = () =>
    this.db
      .collection(COLLECTIONS.driftRecords)
      .withConverter(zodConverter(driftRecordSchema, 'driftRecord'));

  readonly auditEvents = () =>
    this.db
      .collection(COLLECTIONS.auditEvents)
      .withConverter(zodConverter(auditEventSchema, 'auditEvent'));

  readonly userGrants = () =>
    this.db
      .collection(COLLECTIONS.userGrants)
      .withConverter(zodConverter(userGrantSchema, 'userGrant'));

  async getPatient(id: string, tx?: Transaction): Promise<Patient | null> {
    return readOne(this.patients().doc(id), tx);
  }

  async getAdmission(id: string, tx?: Transaction): Promise<Admission | null> {
    return readOne(this.admissions().doc(id), tx);
  }

  async getPerson(id: string, tx?: Transaction): Promise<Person | null> {
    return readOne(this.persons().doc(id), tx);
  }

  async getConnection(id: string): Promise<PccConnection | null> {
    return readOne(this.pccConnections().doc(id));
  }

  /** Resolves a PCC organisation and facility pair to this tenant's facility record. */
  async findFacilityByPcc(
    therapyOrgId: string,
    pccOrgUuid: string,
    pccFacId: string,
  ): Promise<Facility | null> {
    const snapshot = await this.facilities()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('pcc.orgUuid', '==', pccOrgUuid)
      .where('pcc.facId', '==', pccFacId)
      .limit(1)
      .get();

    return snapshot.docs[0]?.data() ?? null;
  }

  /**
   * The contract in force at a facility on a date.
   *
   * The date range is filtered in memory after a narrow indexed query rather than expressed as
   * two inequality clauses. Firestore allows only one range field per composite index, so
   * `effectiveFrom <= date AND effectiveTo >= date` is not a query it can serve; a tenant has a
   * handful of contracts per facility, so filtering the small result set is the right trade.
   */
  async findActiveContract(
    therapyOrgId: string,
    facilityId: string,
    onDate: string,
  ): Promise<FacilityContract | null> {
    const snapshot = await this.facilityContracts()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('facilityId', '==', facilityId)
      .get();

    return (
      snapshot.docs
        .map((doc) => doc.data())
        .find((contract) => isContractActiveOn(contract, onDate)) ?? null
    );
  }

  async listCoveragesForPatient(therapyOrgId: string, patientId: string): Promise<Coverage[]> {
    const snapshot = await this.coverages()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('patientId', '==', patientId)
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * Coverage for many patients in as few queries as Firestore allows.
   *
   * This is the method that stops a caseload screen from issuing one read per patient. The
   * chunked `in` clauses run concurrently, so rendering ninety patients costs three queries
   * instead of ninety round trips. The naive version is the single most common performance defect
   * in a Firestore codebase, and it is invisible until the dataset is real.
   */
  async listCoveragesForPatients(
    therapyOrgId: string,
    patientIds: readonly string[],
  ): Promise<Map<string, Coverage[]>> {
    const grouped = new Map<string, Coverage[]>();
    if (patientIds.length === 0) return grouped;

    const unique = [...new Set(patientIds)];
    const snapshots = await Promise.all(
      chunk(unique).map((batch) =>
        this.coverages()
          .where('therapyOrgId', '==', therapyOrgId)
          .where('patientId', 'in', batch)
          .get(),
      ),
    );

    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        const coverage = doc.data();
        const bucket = grouped.get(coverage.patientId);
        if (bucket === undefined) {
          grouped.set(coverage.patientId, [coverage]);
        } else {
          bucket.push(coverage);
        }
      }
    }

    return grouped;
  }

  async listAdmissionsForPatient(therapyOrgId: string, patientId: string): Promise<Admission[]> {
    const snapshot = await this.admissions()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('patientId', '==', patientId)
      .get();

    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * Candidate people for identity matching.
   *
   * Two narrow queries rather than one broad scan: date of birth is by far the most selective
   * signal, and surname catches the case where a birth date is missing on one side. Both are
   * capped, because a matching routine that degrades with tenant size will eventually be the
   * slowest thing in the sync.
   *
   * Note that this requires indexing demographic fields, which means an index over identifying
   * data. That is unavoidable for record matching and is called out in the data model
   * documentation rather than left as a surprise.
   */
  async findPersonCandidates(
    therapyOrgId: string,
    demographics: { lastName: string; birthDate: string | null },
    limit = 25,
  ): Promise<Person[]> {
    const queries = [
      this.persons()
        .where('therapyOrgId', '==', therapyOrgId)
        .where('demographics.lastName', '==', demographics.lastName)
        .limit(limit)
        .get(),
    ];

    if (demographics.birthDate !== null) {
      queries.push(
        this.persons()
          .where('therapyOrgId', '==', therapyOrgId)
          .where('demographics.birthDate', '==', demographics.birthDate)
          .limit(limit)
          .get(),
      );
    }

    const snapshots = await Promise.all(queries);
    const byId = new Map<string, Person>();

    for (const snapshot of snapshots) {
      for (const doc of snapshot.docs) {
        const person = doc.data();
        // A merged-away person must never be a match target; the surviving record is the answer.
        if (person.mergedIntoPersonId !== null) continue;
        byId.set(person.id, person);
      }
    }

    return [...byId.values()];
  }

  /** Facility ids a person has already been seen at, used as a matching signal. */
  async listFacilityIdsForPerson(therapyOrgId: string, personId: string): Promise<string[]> {
    const snapshot = await this.patients()
      .where('therapyOrgId', '==', therapyOrgId)
      .where('personId', '==', personId)
      .get();

    return [...new Set(snapshot.docs.map((doc) => doc.data().facilityId))];
  }

  cursorId(therapyOrgId: string, facilityId: string, entityType: SyncEntityType): string {
    return `${therapyOrgId}__${facilityId}__${entityType}`;
  }

  async getCursor(
    therapyOrgId: string,
    facilityId: string,
    entityType: SyncEntityType,
  ): Promise<SyncCursor | null> {
    return readOne(this.syncCursors().doc(this.cursorId(therapyOrgId, facilityId, entityType)));
  }
}

async function readOne<T>(ref: DocumentReference<T>, tx?: Transaction): Promise<T | null> {
  const snapshot = tx === undefined ? await ref.get() : await tx.get(ref);
  return snapshot.exists ? (snapshot.data() as T) : null;
}

export type TypedCollection<T> = CollectionReference<T>;
