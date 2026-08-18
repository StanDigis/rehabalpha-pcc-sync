# Data model

Firestore is the integration store and the read model for RehabAlpha clinical apps. All collections are **top-level** with a denormalised `therapyOrgId` on every document. See [ADR-001](ADR.md#adr-001-flat-collections-with-explicit-tenant-field).

## Entity relationship (logical)

```
therapyOrg ──┬── facility ──┬── facilityContract
             │              └── patient ──┬── admission
             │                            └── coverage
             ├── pccConnection
             ├── person ◄──── (linked via patient.personId)
             └── personMatchCandidate (review queue)

syncEvent ──► syncDeadLetter (on exhaustion)
syncCursor, reconciliationRun, driftRecord (ops)
auditEvent, userGrant (cross-cutting)
```

## Collections

### Tenancy & contracts

#### `therapyOrgs/{id}`

Contract therapy company (tenant).

| Field                      | Type                    | Notes                |
| -------------------------- | ----------------------- | -------------------- |
| `id`                       | string                  | e.g. `org_healthpro` |
| `legalName`, `displayName` | string                  |                      |
| `status`                   | `active` \| `suspended` |                      |
| `createdAt`                | ISO datetime            |                      |

#### `facilities/{id}`

A SNF/LTC site the therapy org serves.

| Field                      | Type         | Notes                                  |
| -------------------------- | ------------ | -------------------------------------- |
| `therapyOrgId`             | string       | Tenant                                 |
| `name`                     | string       | Display                                |
| `timeZone`                 | IANA         | Date boundaries for contracts/coverage |
| `pcc.orgUuid`, `pcc.facId` | string       | Upstream identifiers                   |
| `createdAt`                | ISO datetime |                                        |

**Index:** `(therapyOrgId, pcc.orgUuid, pcc.facId)` — webhook facility resolution.

#### `facilityContracts/{id}`

Legal basis for pulling data from a facility.

| Field                          | Type                                  | Notes                   |
| ------------------------------ | ------------------------------------- | ----------------------- |
| `therapyOrgId`, `facilityId`   | string                                |                         |
| `disciplines`                  | `PT` \| `OT` \| `SLP`[]               |                         |
| `effectiveFrom`, `effectiveTo` | ISO date                              | `null` end = open-ended |
| `status`                       | `active` \| `expired` \| `terminated` |                         |
| `createdAt`                    | ISO datetime                          |                         |

Contract check runs **before every sync**. Expired contract → no new pulls; existing chart rows remain (retention / submitted claims).

#### `pccConnections/{id}`

OAuth connection to a PCC organisation.

| Field                         | Type                                 | Notes                                  |
| ----------------------------- | ------------------------------------ | -------------------------------------- |
| `therapyOrgId`                | string                               |                                        |
| `pccOrgUuid`                  | string                               |                                        |
| `authMode`                    | `twoLegged` \| `threeLegged`         |                                        |
| `credentialSecretName`        | string                               | Secret Manager ref — **not** the token |
| `activatedFacilityIds`        | string[]                             | PCC fac IDs                            |
| `consent`                     | object                               | status, grantedAt, expiresAt           |
| `scopes`                      | string[]                             |                                        |
| `status`                      | `healthy` \| `degraded` \| `revoked` |                                        |
| `lastVerifiedAt`, `createdAt` | ISO datetime                         |                                        |

### Clinical projections (PCC-sourced)

#### `persons/{id}`

The human behind one or more facility-specific patient records.

| Field                    | Type           | Notes                                             |
| ------------------------ | -------------- | ------------------------------------------------- |
| `therapyOrgId`           | string         |                                                   |
| `demographics`           | object         | first/last name, DOB, gender, …                   |
| `demographicsSource`     | object         | which patient projection last updated master demo |
| `mergedIntoPersonId`     | string \| null | Soft-merge target; excluded from matching         |
| `createdAt`, `updatedAt` | ISO datetime   |                                                   |

Document id: deterministic from PCC org + first seen patient id until linked.

#### `patients/{id}`

Facility-scoped PCC patient projection.

| Field                          | Type           | Notes                                 |
| ------------------------------ | -------------- | ------------------------------------- |
| `therapyOrgId`, `facilityId`   | string         |                                       |
| `personId`                     | string \| null | Set after identity resolution         |
| `personLink`                   | object         | method, confidence, status, decidedAt |
| `pcc.patientId`, `pcc.orgUuid` | string         |                                       |
| `pcc.patientStatus`            | enum           | CURRENT, DISCHARGED, …                |
| `demographics`                 | object         |                                       |
| `currentAdmissionId`           | string \| null | Denormalised for caseload lists       |
| `sync`                         | sync metadata  | watermark, hash, last sync            |

Document id: `pat_{hash(orgUuid, pccPatientId)}` — stable across events.

#### `admissions/{id}`

Stay / ADT reconstruction.

| Field                                                 | Type                                    | Notes |
| ----------------------------------------------------- | --------------------------------------- | ----- |
| `therapyOrgId`, `facilityId`, `patientId`, `personId` | string                                  |       |
| `status`                                              | `admitted` \| `discharged` \| `pending` |       |
| `admitDate`, `dischargeDate`                          | ISO date                                |       |
| `location`                                            | unit/room/bed                           |       |
| `sync`                                                | metadata                                |       |

**Leave of absence:** one continuous stay with gap semantics — not two admissions. Test: Betty hospital return.

#### `coverages/{id}`

Bitemporal payer row. **Never hard-deleted.**

| Field                                     | Type                                           | Notes                                      |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| `therapyOrgId`, `facilityId`, `patientId` | string                                         |                                            |
| `pccPayerId`, payer name/type/plan        | object                                         |                                            |
| `rank`                                    | primary / secondary / tertiary / informational |                                            |
| `effectiveFrom`, `effectiveTo`            | ISO date                                       | Real-world validity                        |
| `recordedAt`, `supersededAt`              | ISO datetime                                   | System belief timeline                     |
| `status`                                  | active / ended / superseded                    |                                            |
| `closure`                                 | reason, closedAt, `inferred`                   | Inferred = payer vanished without end date |
| `authorization`                           | optional                                       | visits, dates, number                      |
| `sync`                                    | metadata                                       |                                            |

**Two time axes:**

- _Effective_ — when coverage was in force in the real world (billing question)
- _Recorded_ — when RehabAlpha believed it (audit question)

Example: Medicare ends 15 Sep, Medicaid starts 16 Sep — both rows exist with correct dates.

### Identity review

#### `personMatchCandidates/{id}`

Id: `{patientId}__{candidatePersonId}`

| Field                                       | Type                           | Notes                                |
| ------------------------------------------- | ------------------------------ | ------------------------------------ |
| `score`                                     | 0–1                            | Jaro-Winkler + signal weighting      |
| `signals`                                   | object                         | DOB, last name, MRN, shared facility |
| `status`                                    | pending / confirmed / rejected |                                      |
| `decidedByUid`, `decidedAt`, `decisionNote` |                                | Human decision                       |

Fuzzy matches **never** auto-link. See [ADR-004](ADR.md#adr-004-no-automatic-fuzzy-identity-merge).

### Sync & operations

#### `syncEvents/{messageId}`

One row per PCC webhook message id (dedupe key).

#### `syncCursors/{therapyOrgId__facilityId__entityType}`

Reconciliation watermark + health.

#### `syncDeadLetters/{id}`

Exhausted or permanent failures; stores full `task` for replay.

#### `reconciliationRuns/{id}`, `driftRecords/{id}`

Sweep history and PCC vs local disagreements.

#### `auditEvents/{id}`

Append-only. Integration mutations **and** user reads (HIPAA audit control).

#### `userGrants/{uid}`

Roles, facility scope, `grantVersion` for revocation.

## Sync metadata (embedded)

Every synced entity carries:

```typescript
sync: {
  pccLastModified: string | null; // upstream watermark
  contentHash: string; // canonical hash of PCC-owned fields
  lastSyncedAt: string;
  lastSyncSource: 'webhook' | 'reconciliation' | 'operatorReplay';
}
```

Watermark decisions: create | update | advanceWatermark | skip (stale | unchanged).

## Indexing strategy

All composite indexes in `firestore.indexes.json` map 1:1 to queries in code. Notable patterns:

- Tenant + facility scoping on list screens
- `(therapyOrgId, patientId)` on coverages — batch `in` queries chunked at 30
- Demographics indexes for identity candidate search — **identifying data indexed by necessity**; access restricted by rules

Range on both `effectiveFrom` and `effectiveTo` is **not** indexed — filtered in memory over small per-facility result sets (Firestore single-range limitation).

## Document id conventions

| Entity   | Pattern                                                  |
| -------- | -------------------------------------------------------- |
| Patient  | `documentIds.patient(orgUuid, pccPatientId)`             |
| Person   | `documentIds.person(orgUuid, pccPatientId)` until merged |
| Coverage | includes payer id + effectiveFrom                        |
| Cursor   | `{therapyOrgId}__{facilityId}__{entityType}`             |

## Fixture characters (tests & demo)

| Character           | Scenario                                                   |
| ------------------- | ---------------------------------------------------------- |
| **Betty Abernathy** | Medicare→Medicaid transition, LOA, readmission at Lakeside |
| **Harold**          | Distinct person — must not merge with Betty                |

Seed script (`npm run seed`) loads Betty into emulator for ops console demo.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — pipelines
- [SECURITY.md](SECURITY.md) — who can read what
- [OPERATIONS.md](OPERATIONS.md) — DLQ and cursors
