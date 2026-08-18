# Architecture

## Context

**Actors**

| Actor                          | Role                                                             |
| ------------------------------ | ---------------------------------------------------------------- |
| **PCC**                        | System of record for SNF/LTC demographics, ADT, coverage         |
| **RehabAlpha**                 | Therapy documentation and billing for contract therapy companies |
| **HealthPRO** (example tenant) | Contract therapy org serving multiple facilities                 |
| **Ferncrest / Lakeside**       | Facilities; each has its own PCC `facId` and local MRN           |
| **Integration operator**       | Runs the pipeline; minimal PHI access                            |

**Scope of sync (PCC-owned fields)**

- Patient demographics and status
- Admissions / stays (including leave-of-absence semantics)
- Coverage / payers and ranks
- Not in scope: therapy notes, goals, signatures — RehabAlpha-owned

## High-level diagram

```
                    ┌─────────────────┐
                    │  PointClickCare │
                    │  (webhooks +    │
                    │   REST API)     │
                    └────────┬────────┘
                             │ HTTPS
                             ▼
              ┌──────────────────────────────┐
              │  pccWebhook (Cloud Function) │
              │  • verify shared secret      │
              │  • dedupe by messageId       │
              │  • persist syncEvent         │
              │  • enqueue Cloud Task        │
              │  • ack < 3s                  │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Cloud Tasks queue (sync)    │
              │  • dedupe by task name       │
              │  • exponential backoff       │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  syncWorker (Cloud Function) │
              │  • bind PCC client per tenant│
              │  • re-fetch from PCC API     │
              │  • apply watermark policy    │
              │  • write Firestore (Admin)   │
              │  • audit every mutation      │
              └──────────────┬───────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   ┌───────────┐      ┌────────────┐     ┌─────────────┐
   │ Firestore │      │ Secret Mgr │     │  Audit log  │
   │ chart +   │      │ OAuth creds│     │  (append)   │
   │ sync meta │      │ per conn   │     └─────────────┘
   └─────┬─────┘      └────────────┘
         │ read-only (rules)
         ▼
   ┌─────────────┐     ┌──────────────────────┐
   │ RehabAlpha  │     │ Ops console (Next.js) │
   │ clinical UI │     │ sync health, DLQ,     │
   │             │     │ identity review       │
   └─────────────┘     └──────────────────────┘

   Scheduled (independent of webhooks):
   • reconciliationDelta — every 15 min
   • reconciliationCensus — nightly 03:00 ET
```

## Monorepo packages

### `@rehabalpha/core`

Pure TypeScript — no I/O. Contains:

- Zod schemas for all persisted entities
- **Watermark policy** — idempotent writes under duplicate/out-of-order webhooks
- **Field ownership** — which fields PCC may overwrite vs RehabAlpha-clinical
- **Coverage timeline** — bitemporal open/close/supersede rules
- **Identity matching** — scoring, thresholds, authoritative vs review paths
- **Authorization** — `ROLE_PERMISSIONS` single source of truth

Property-based and example tests live here; policies are tested without Firestore.

### `@rehabalpha/pcc-client`

HTTP client for PCC's public API surface:

| Capability                | Notes                                                             |
| ------------------------- | ----------------------------------------------------------------- |
| OAuth 2-legged + 3-legged | 3-legged required for Marketplace partners from 2026              |
| Token refresh + rotation  | Refresh tokens in Secret Manager, not Firestore                   |
| Pagination                | Async iterables for patient lists                                 |
| Rate limiting             | Token bucket; respects 429                                        |
| Retries                   | Classified: `RetryableSyncError` vs `PermanentSyncError`          |
| `FakePccApi`              | Programmable fixture for tests — Betty, Harold, payer transitions |

`PCC_TRANSPORT=fixture` blocks real HTTP in dev/CI.

### `@rehabalpha/sync`

Orchestration and persistence:

| Module          | Responsibility                                      |
| --------------- | --------------------------------------------------- |
| `WebhookIngest` | Fast path: validate, dedupe, enqueue                |
| `SyncWorker`    | Execute `SyncTask`, retries, dead-letter            |
| `SyncEngine`    | Patient / admission / coverage / identity pipelines |
| `Reconciler`    | Delta + census sweeps vs webhook cursor             |
| `SyncStore`     | Typed Firestore access + batch helpers              |
| `AuditLog`      | Append-only integration + access events             |

### `apps/functions`

Cloud Functions v2 entrypoints:

| Export                 | Trigger               | Timeout |
| ---------------------- | --------------------- | ------- |
| `pccWebhook`           | HTTPS POST from PCC   | 10s     |
| `syncWorker`           | Cloud Tasks OIDC POST | 540s    |
| `replayDeadLetter`     | HTTPS POST (operator) | 30s     |
| `reconciliationDelta`  | Scheduler /15 min     | 540s    |
| `reconciliationCensus` | Cron 03:00 ET         | 540s    |

Production uses `CloudTasksQueue`; emulator uses `InlineTaskQueue`.

### `apps/web`

Server-rendered ops console. Reads via Admin SDK; **no direct client Firestore writes**. Operator replay goes through API route with `authorize()` check.

## Sync lifecycle

### 1. Webhook ingress

1. PCC POSTs notification (`messageId`, `eventType`, `orgUuid`, `facId`, `patientId`, …).
2. Handler resolves `pccConnections` → `therapyOrgId`.
3. `syncEvents/{messageId}` created (dedupe — duplicate delivery is a no-op at ingest).
4. Cloud Task enqueued with `entityType`, `scope`, `entityPccId`, correlation to event.
5. HTTP 200 returned immediately.

**Why re-fetch in the worker:** webhook payloads are notifications, not guaranteed full snapshots. Re-reading ensures we apply the same transform path as reconciliation.

### 2. Worker execution

For each `SyncTask`:

1. Load active `facilityContract` — no sync without contract (legal basis for data access).
2. Create PCC client bound to tenant connection + secrets.
3. Fetch patient / ADT / coverage from PCC.
4. Transform → domain models.
5. Apply watermark decision per document.
6. Identity resolution if patient unlinked.
7. Commit in Firestore transaction where needed.
8. Update `syncEvent` status; audit success/failure.

**Retry policy:** transient errors (429, 5xx, network) schedule delayed retry with backoff. Permanent errors (403, validation) → dead letter on first failure.

### 3. Reconciliation

Two modes answer different questions:

| Mode       | Question                              | Frequency        |
| ---------- | ------------------------------------- | ---------------- |
| **Delta**  | What changed since cursor?            | Every 15 minutes |
| **Census** | Does our facility census match PCC's? | Nightly          |

Delta uses `modifiedSince` with **15-minute overlap** to avoid same-second clock skew misses. Census compares ID sets and raises `driftRecords` for investigation.

Cursor state is stored in `syncCursors` and surfaced in the ops console.

## Failure handling

| Failure                     | Behaviour                                     |
| --------------------------- | --------------------------------------------- |
| Transient PCC / network     | Retry with backoff; Cloud Tasks dedupe        |
| Permanent (consent revoked) | Dead letter; operator notified                |
| Schema drift in Firestore   | Converter throws on read — fails loudly       |
| Watermark stale             | Skip write — idempotent                       |
| Identity ambiguous          | `personMatchCandidates` queue — no auto-merge |

Dead letters store the **full original task envelope** so replay is bit-exact.

## Multi-tenancy

- Every document carries `therapyOrgId`.
- Firebase Auth custom claims carry `{ therapyOrgId, roles, grantVersion }` (small).
- Facility scope lives in `userGrants/{uid}` (can exceed claim size limits).
- Rules compare document tenant to claim tenant on every read.

## Testing strategy

| Layer                  | Tool                           | Count |
| ---------------------- | ------------------------------ | ----- |
| Policies & transforms  | vitest                         | 225   |
| Sync pipeline + engine | vitest + Firestore emulator    | 66    |
| Firestore rules        | `@firebase/rules-unit-testing` | 31    |
| Cloud Functions HTTP   | vitest + emulator              | 4     |
| Ops console E2E        | Playwright + seed              | 1     |

No in-memory Firestore fake for integration tests — behaviour under test _is_ Firestore behaviour.

## Deployment (outline)

Not fully automated in this repo; intended layout:

- Firebase project per environment
- Functions v2 in `us-central1`
- Cloud Tasks queue `sync` with OIDC to `syncWorker`
- Secret Manager: OAuth client secret + per-connection refresh tokens
- Firestore indexes deployed from `firestore.indexes.json`
- Rules from `firestore.rules`

See [SECURITY.md](SECURITY.md) for credential handling.

## Related documents

- [DATA-MODEL.md](DATA-MODEL.md) — entity reference
- [SECURITY.md](SECURITY.md) — auth and PHI
- [OPERATIONS.md](OPERATIONS.md) — runbooks
- [ADR.md](ADR.md) — decision log
