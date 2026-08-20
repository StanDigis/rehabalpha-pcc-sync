# Data mapping — PointClickCare → RehabAlpha

Field-level mapping for the three synchronised data types (patients, admissions, coverage). Transformers live in `packages/sync/src/transform/`.

**Ownership legend**

| Tag          | Meaning                                                        |
| ------------ | -------------------------------------------------------------- |
| **PCC**      | Upstream source of truth; sync may overwrite on reconciliation |
| **RA**       | RehabAlpha-owned; preserved by `planProjectionWrite`           |
| **Derived**  | Computed during sync from other fields                         |
| **Clinical** | Stored outside sync scope (therapy documentation)              |

---

## Patient (`patients/{id}`)

Document id: `pat_{deterministicHash(pccOrgUuid, pccPatientId)}`

| RehabAlpha field                   | PCC source                    | Owner   | Notes                                                   |
| ---------------------------------- | ----------------------------- | ------- | ------------------------------------------------------- |
| `id`                               | —                             | Derived | Stable across webhook retries                           |
| `therapyOrgId`                     | —                             | Derived | From `pccConnections` resolution                        |
| `facilityId`                       | `patient.facId`               | Derived | Authoritative fac from patient record, not webhook hint |
| `personId`                         | —                             | **RA**  | Set by identity policy; never reset by projection       |
| `personLink`                       | —                             | **RA**  | method, confidence, status, decidedAt                   |
| `pcc.orgUuid`                      | connection                    | PCC     |                                                         |
| `pcc.facId`                        | `patient.facId`               | PCC     |                                                         |
| `pcc.patientId`                    | `patient.patientId`           | PCC     | Natural key                                             |
| `pcc.patientStatus`                | `patient.patientStatus`       | PCC     | CURRENT, DISCHARGED, …                                  |
| `demographics.firstName`           | `patient.firstName`           | PCC     |                                                         |
| `demographics.lastName`            | `patient.lastName`            | PCC     |                                                         |
| `demographics.middleName`          | `patient.middleName`          | PCC     |                                                         |
| `demographics.preferredName`       | `patient.preferredName`       | PCC     |                                                         |
| `demographics.birthDate`           | `patient.birthDate`           | PCC     | Normalised to ISO date                                  |
| `demographics.administrativeSex`   | `patient.gender`              | PCC     | Open enum                                               |
| `demographics.medicalRecordNumber` | `patient.medicalRecordNumber` | PCC     | Used for exact identity match                           |
| `currentAdmissionId`               | ADT set                       | **RA**  | Denormalised pointer; recalculated each admission sync  |
| `sync.*`                           | `patient.lastUpdateDatetime`  | **RA**  | Watermark, contentHash, syncedAt, source                |

Transformer: `toPatientProjection()` in `transform/patient.ts`.

---

## Admission (`admissions/{id}`)

Built from the **full ADT list** per patient on each sync (not incremental patch).

| RehabAlpha field             | PCC source          | Owner   | Notes                                                 |
| ---------------------------- | ------------------- | ------- | ----------------------------------------------------- |
| `id`                         | —                   | Derived | From org + patient + admit event identity             |
| `therapyOrgId`, `facilityId` | context             | Derived |                                                       |
| `patientId`                  | parent patient      | Derived |                                                       |
| `personId`                   | `patient.personId`  | Derived | Copied on every write; propagates after identity link |
| `status`                     | ADT action codes    | PCC     | admitted / discharged / pending                       |
| `admitDate`                  | ADT effective date  | PCC     |                                                       |
| `dischargeDate`              | ADT discharge event | PCC     | null while active                                     |
| `location.unit/room/bed`     | ADT location        | PCC     |                                                       |
| `leaveOfAbsence`             | ADT LOA sequence    | PCC     | Single continuous stay semantics                      |
| `sync.*`                     | ADT timestamps      | PCC/RA  | Watermark on PCC-owned fields                         |

Transformer: `toAdmissionProjections()` in `transform/admission.ts`.  
Engine: `syncAdmissions()` — single transaction for all stays + `currentAdmissionId` update.

**Not mapped from PCC:** therapy authorizations, visit counts, plan-of-care — those are RehabAlpha clinical/billing workflows.

---

## Coverage (`coverages/{id}`)

Bitemporal rows — **never hard-deleted**.

| RehabAlpha field                          | PCC source          | Owner   | Notes                                          |
| ----------------------------------------- | ------------------- | ------- | ---------------------------------------------- |
| `id`                                      | —                   | Derived | Includes payer id + effectiveFrom              |
| `therapyOrgId`, `facilityId`, `patientId` | context             | Derived |                                                |
| `pccPayerId`                              | payer.id            | PCC     |                                                |
| `payer.name`, `payer.type`, `payer.plan`  | payer fields        | PCC     | Sanitized in ops console (types only)          |
| `rank`                                    | payer order         | PCC     | primary / secondary / tertiary / informational |
| `effectiveFrom`, `effectiveTo`            | payer dates         | PCC     | Real-world validity axis                       |
| `recordedAt`, `supersededAt`              | —                   | **RA**  | When we believed / stopped believing           |
| `status`                                  | —                   | Derived | active / ended / superseded                    |
| `closure.reason`, `closure.inferred`      | —                   | Derived | Inferred when payer vanishes without end date  |
| `authorization.*`                         | auth endpoints      | PCC     | When present in PCC payload                    |
| `sync.*`                                  | payer modified time | PCC/RA  |                                                |

Transformer: `toCoverageProjections()` in `transform/coverage.ts`.

---

## Person (`persons/{id}`)

| RehabAlpha field     | Source                        | Owner  | Notes                                   |
| -------------------- | ----------------------------- | ------ | --------------------------------------- |
| `demographics`       | First linked patient or merge | **RA** | Master demo for cross-facility identity |
| `demographicsSource` | —                             | **RA** | Which patient projection last updated   |
| `mergedIntoPersonId` | operator merge                | **RA** | Excluded from future matching           |

---

## Identity review (`personMatchCandidates/{id}`)

Not a PCC mapping — generated when fuzzy match score ≥ 0.55 and no authoritative link exists.

| Field                    | Source                                       |
| ------------------------ | -------------------------------------------- |
| `score`, `signals`       | `resolveIdentity()` in `@rehabalpha/core`    |
| `status`, `decidedByUid` | Human via ops console (future: clinical app) |

---

## What sync does not touch

| RehabAlpha data                     | Reason                                     |
| ----------------------------------- | ------------------------------------------ |
| Treatment notes, evaluations, goals | Clinical workflow; therapist-authored      |
| Billing claims and line items       | Derived from documentation + synced payers |
| User accounts, grants               | Separate auth domain                       |
| Audit of chart **reads**            | Instrumented separately from sync writes   |

---

## Conflict resolution summary

```
Incoming PCC projection
        │
        ▼
planProjectionWrite(incoming, stored, ownership, overrides)
        │
        ├─ PCC-owned path changed     → apply upstream
        ├─ RA-owned path              → keep stored value
        ├─ Active local override      → keep stored, log overrideHeld
        └─ Expired override + diff    → apply upstream, log overrideExpired
```

See `packages/core/src/policy/field-ownership.ts` and tests in `field-ownership.test.ts`.

---

## Related documents

- [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md) — when these rules matter in practice
- [DATA-MODEL.md](./DATA-MODEL.md) — full Firestore schema
- [ADR.md](./ADR.md) — decision records (bitemporal coverage, identity, watermarks)
