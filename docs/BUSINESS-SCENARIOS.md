# Business scenarios

How this integration handles real-world situations a contract therapy company faces when PointClickCare becomes the source of truth for demographics, stays, and payers.

This document answers the product questions reviewers typically ask. Implementation details live in [DATA-MAPPING.md](./DATA-MAPPING.md), [CUTOVER.md](./CUTOVER.md), and the code paths referenced below.

---

## Betty — the reference patient

The seed dataset and tests centre on **Betty Abernathy**:

| Scenario                                     | What happens                                          | Where to look                                            |
| -------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------- |
| Returns to a sister facility under a new MRN | Authoritative PCC master-patient link → same `person` | `identity-sync.ts`, sync-engine test "Betty at Lakeside" |
| Medicare → Medicaid payer change             | Old row closed, new row opened; both kept             | `/patients/demo-betty/coverage`, `coverage-sync.ts`      |
| Leave of absence → hospital → return         | One continuous stay, not two admissions               | `admission.ts` transformer, DATA-MODEL LOA note          |
| Sync fails (revoked consent)                 | Dead letter; patient may be stale until replay        | `/dead-letters`, seed `pcc_forbidden`                    |
| Fuzzy duplicate (similar name, new MRN)      | 78% match → identity queue, **never auto-linked**     | `/identity-review`, ADR-004                              |

---

## Scenario 1: Facility already has data in RehabAlpha when sync is turned on

**Question:** What happens to charts that therapists created before PCC sync existed?

**Approach:**

1. **PCC-sourced fields** (demographics, stays, payers) are populated by the first successful sync per patient.
2. **RehabAlpha-owned fields** (therapy documentation, goals, notes) live in separate collections the sync engine never writes to.
3. **Identity resolution** decides whether a new PCC patient maps to an existing `person` or needs human review — see [CUTOVER.md](./CUTOVER.md).
4. **Nightly census reconciliation** finds PCC patients we have never seen via webhook and enqueues sync for them.
5. Nothing is auto-deleted because PCC no longer lists a patient (`driftRecords` kind `missingUpstream` → human decision).

We do **not** assume RehabAlpha is empty on day one. Cutover is a phased process, not a flag flip.

---

## Scenario 2: How data mapping works

PCC API responses are transformed into RehabAlpha read-model documents. Field-level mapping and ownership rules: [DATA-MAPPING.md](./DATA-MAPPING.md).

Summary:

| PCC concept           | RehabAlpha entity | Notes                                 |
| --------------------- | ----------------- | ------------------------------------- |
| Organisation + facId  | `facility`        | Resolved before every sync            |
| Patient               | `patients/{id}`   | Stable id from org + PCC patient id   |
| ADT records           | `admissions/{id}` | Rebuilt as a set per sync transaction |
| Payer rows            | `coverages/{id}`  | Bitemporal; never hard-deleted        |
| Cross-facility person | `persons/{id}`    | Linked via identity policy            |

Clinical documentation (evaluations, treatment notes, billing line items) is **out of scope for sync** — therapists continue to author those in RehabAlpha.

---

## Scenario 3: Accidental duplicates

**Question:** How are duplicate patients prevented?

**Layers:**

1. **Stable document ids** — `pat_{hash(orgUuid, pccPatientId)}`. Replaying the same webhook updates the same row.
2. **Webhook dedupe** — `syncEvents/{messageId}`; duplicate delivery is a no-op at ingest.
3. **Watermark + content hash** — out-of-order or repeated events do not corrupt state (`decideWrite` in `@rehabalpha/core`).
4. **Identity policy** — fuzzy similarity ≥ 55% goes to `personMatchCandidates` for human confirm/reject. No automatic merge (ADR-004).
5. **Authoritative auto-link only when:**
   - PCC organisation master patient record confirms the link, or
   - Exact medical record number match at the same facility.

Wrong merges are treated as a clinical safety incident; the default is conservative.

---

## Scenario 4: Patients map, but admissions do not line up

**Question:** Two patient records link to the same person, but stay history disagrees — what then?

**How the code handles it:**

- Admissions are **rebuilt from the full ADT stream** on each sync, in one transaction — not patched one event at a time.
- `personId` on every admission is **derived from the linked patient on each write**, so confirming an identity link propagates to all stays without a separate backfill job.
- `currentAdmissionId` on the patient is recalculated from active stays (LOA counts as active).
- ADT records that cannot be attributed to a stay surface as warnings (`admission.unattributedAdtRecord`) in sync outcomes and audit log.
- Census reconciliation raises `driftRecords` when PCC and local copies disagree on PCC-owned fields.

**What we do not do:** silently merge conflicting stay timelines from two different PCC patient ids into one admission. Each facility patient id owns its ADT-derived stays until identity is confirmed at the person level.

**Open product question:** UI for resolving conflicting stay histories after a confirmed person merge — see [QUESTIONS.md](./QUESTIONS.md) item 15 (discharge workflow).

---

## Scenario 5: PCC data is stale; therapist needs to update something

**Question:** Therapist knows the facility chart is wrong. Can they proceed?

**Field ownership** (`packages/core/src/policy/field-ownership.ts`):

| Owner              | Examples                                                      | Sync behaviour                     |
| ------------------ | ------------------------------------------------------------- | ---------------------------------- |
| PCC                | Demographics, ADT dates, payer ranks                          | Upstream wins on reconciliation    |
| RehabAlpha         | `personId`, `personLink`, `currentAdmissionId`, sync metadata | Preserved across projections       |
| Therapist override | Any PCC-owned path, time-boxed                                | Held locally until expiry; audited |

**Local override flow:**

1. Therapist (or admin) pins a field value with reason and optional expiry.
2. While active, sync reports `overrideHeld` — upstream change is **not** applied.
3. When override expires, next sync applies PCC value and records `overrideExpired`.

Therapy documentation is never overwritten because it is stored outside the PCC projection documents.

---

## Scenario 6: Attributes that exist only in RehabAlpha

**Question:** Can therapists edit fields PCC does not have?

**Yes.** Anything not in the PCC projection is RehabAlpha-native:

- Treatment plans, session notes, outcomes, discipline-specific assessments
- Billing workflow state RehabAlpha derives from documentation
- Identity links and operator decisions

The sync engine only writes to `patients`, `admissions`, `coverages`, and identity-related collections. It applies `planProjectionWrite` so RehabAlpha-owned paths on synced documents are never clobbered.

Default rule: **if a field is not explicitly marked RehabAlpha-owned, PCC wins** — adding a new projected field without an ownership decision fails safe.

---

## Operator vs therapist UX

| User                 | Surface in this repo                   | Purpose                                                       |
| -------------------- | -------------------------------------- | ------------------------------------------------------------- |
| Integration operator | Ops console (`apps/web`)               | Sync health, dead letters, identity queue, sanitized coverage |
| Therapist / biller   | RehabAlpha clinical app (not included) | Documentation, overrides, chart access                        |

This submission delivers the **integration layer and operator tooling**. Clinical UX for overrides and cutover wizards would sit in the main RehabAlpha product — policies and hooks are ready (`field-ownership`, `personMatchCandidates`, audit log).

---

## Tests that exercise these scenarios

| Scenario                           | Test location                                   |
| ---------------------------------- | ----------------------------------------------- |
| Watermark / out-of-order           | `packages/sync/tests/sync-engine.test.ts`       |
| Field ownership preserved          | `sync-engine.test.ts` "field ownership"         |
| Identity authoritative + fuzzy     | `sync-engine.test.ts` "identity resolution"     |
| Payer transition                   | `sync-engine.test.ts` coverage + Betty fixtures |
| Webhook dedupe                     | `packages/sync/tests/pipeline.test.ts`          |
| Census drift                       | `pipeline.test.ts` reconciliation               |
| Firestore rules / tenant isolation | `tests/rules/`                                  |

Run: `npm run verify` (with emulators).

---

## Related documents

| Doc                                  | Contents                                           |
| ------------------------------------ | -------------------------------------------------- |
| [CUTOVER.md](./CUTOVER.md)           | Day-one rollout when RehabAlpha already has charts |
| [DATA-MAPPING.md](./DATA-MAPPING.md) | PCC → RehabAlpha field mapping                     |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Components and data flow                           |
| [QUESTIONS.md](./QUESTIONS.md)       | Items needing PCC or product decision              |
