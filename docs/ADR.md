# Architecture Decision Records

Index of significant decisions. Format: context → decision → consequences.

---

## ADR-001: Flat collections with explicit tenant field

**Status:** Accepted

**Context:** Firestore nested layouts (`therapyOrgs/{id}/patients/…`) read naturally but break cross-facility queries ("all open dead letters for this tenant"). Collection-group queries cannot constrain tenant by path alone.

**Decision:** Top-level collections with required `therapyOrgId` on every document. Security rules compare `resource.data.therapyOrgId` to JWT claim.

**Consequences:**

- (+) Ops queries and rules stay aligned — same field in query filter and rule check
- (+) No collection-group tenant leak risk
- (−) Redundant tenant field on every document (enforced by Zod schemas)
- (−) Discipline required on every write path

**References:** `packages/sync/src/firestore/collections.ts`, `firestore.rules`

---

## ADR-002: Bitemporal coverage (never delete)

**Status:** Accepted

**Context:** Payer transitions (Medicare → Medicaid) and retroactive corrections require answering "what did we believe on date X" for claim resubmission. Single mutable coverage row loses history.

**Decision:** Coverage rows are append-only in effect: close with `effectiveTo`, supersede with new row, never hard-delete. Track both effective dates and `recordedAt` / `supersededAt`.

**Consequences:**

- (+) Auditable billing history
- (+) Correct handling of Betty scenario (dual rows at transition)
- (−) More storage; UI must render timeline not single row
- (−) Inferred closure when payer vanishes — flagged for operator review

**References:** `packages/core/src/domain/coverage.ts`, `packages/core/src/policy/coverage-timeline.ts`

---

## ADR-003: Watermark instead of global ordering

**Status:** Accepted

**Context:** PCC webhooks are at-least-once and unordered. Imposing ordering (Kafka partition key, sequence numbers) adds cost and still duplicates.

**Decision:** Each document stores `pccLastModified` + `contentHash`. Apply write only if incoming watermark ≥ stored (with content-hash tie-break). Duplicates and late events become no-ops.

**Consequences:**

- (+) Idempotent, commutative sync — property tested
- (+) No ordering infrastructure
- (−) Requires trustworthy upstream modification timestamp
- (−) Forced resync path needed for operator corrections (`force` flag + audit)

**References:** `packages/core/src/policy/watermark.ts`

---

## ADR-004: No automatic fuzzy identity merge

**Status:** Accepted

**Context:** Wrong patient merge is a serious clinical incident. Similar names at same facility happen.

**Decision:** Auto-link only on authoritative signals (PCC org master patient, exact MRN at facility). Scores above review threshold create `personMatchCandidate`; human decides.

**Consequences:**

- (+) Safety over automation
- (−) Operator queue volume
- (−) Demographic fields indexed for candidate search — privacy trade documented

**References:** `packages/core/src/policy/identity-match.ts`, `packages/sync/src/engine/identity-sync.ts`

---

## ADR-005: Webhook fast-ack + async worker

**Status:** Accepted

**Context:** PCC expects HTTP response within seconds. Full patient+coverage sync can take tens of seconds and hits rate limits.

**Decision:** Webhook handler persists event, enqueues Cloud Task, returns 200. Worker re-reads PCC API and writes Firestore.

**Consequences:**

- (+) Reliable ack; work retried independently
- (+) Same code path as reconciliation
- (−) Cloud Tasks required (no local emulator — `TaskQueue` port + inline adapter)
- (−) Eventual consistency window

**References:** `apps/functions/src/handlers/pcc-webhook.ts`, `packages/sync/src/task-queue.ts`

---

## ADR-006: Deny all client Firestore writes

**Status:** Accepted

**Context:** All chart projections are integration-owned or server-mediated. Client direct writes bypass audit and authorisation logic.

**Decision:** `allow write: if false` for all collections in rules. Mutations via Admin SDK in Functions / controlled server routes only.

**Consequences:**

- (+) Compromised token cannot corrupt chart
- (+) Single audit path for mutations
- (−) Every operator action needs an API endpoint
- (−) RehabAlpha clinical edits need separate write path with field ownership checks

**References:** `firestore.rules`, `apps/web/app/api/dead-letters/[id]/replay/route.ts`

---

## ADR-007: Credentials in Secret Manager, not Firestore

**Status:** Accepted

**Context:** OAuth refresh tokens are long-lived secrets. Firestore is widely replicated and readable by rules-tested clients.

**Decision:** `pccConnections` stores Secret Manager resource names only. Functions resolve at runtime.

**Consequences:**

- (+) Secrets not in client-readable store
- (−) Extra IAM for Functions service account
- (−) Emulator uses `InMemorySecretStore`

**References:** `apps/functions/src/pcc/secret-store.ts`, `packages/core/src/domain/tenancy.ts`

---

## ADR-008: integrationOperator role without chart read

**Status:** Accepted

**Context:** HIPAA minimum necessary — fixing sync should not require clinical record access.

**Decision:** `integrationOperator` has sync health, dead letter, identity queue read — not `patient:read`. Ops console coverage view is sanitized.

**Consequences:**

- (+) Separation of duties
- (−) Operator cannot visually compare two charts during identity review — by design; clinical role must decide

**References:** `packages/core/src/domain/authorization.ts`, `apps/web/app/patients/[patientId]/coverage/page.tsx`

---

## ADR-009: Real Firestore emulator in integration tests

**Status:** Accepted

**Context:** In-memory Firestore fakes don't reproduce transaction limits, converter behaviour, or index requirements.

**Decision:** Integration tests require `FIRESTORE_EMULATOR_HOST`. Each suite uses isolated emulator project id.

**Consequences:**

- (+) Tests catch real failure modes (partial cursor merge, N+1, index gaps)
- (−) Slower tests; JDK dependency
- (−) CI must run emulators (firebase-tools `emulators:exec`)

**References:** `packages/sync/tests/harness.ts`, `scripts/with-emulators.mjs`

---

## Template for new ADRs

```markdown
## ADR-NNN: Title

**Status:** Proposed | Accepted | Superseded

**Context:** …

**Decision:** …

**Consequences:** (+) … (−) …

**References:** …
```
