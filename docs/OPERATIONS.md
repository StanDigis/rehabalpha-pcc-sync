# Operations

Runbooks for integration operators and on-call engineers. Assumes production deployment on Firebase/GCP with the ops console (`apps/web`) or direct API access.

## Dashboards & entry points

| Surface          | URL / entry                                                         | Purpose                       |
| ---------------- | ------------------------------------------------------------------- | ----------------------------- |
| Ops console      | `/` (Overview), `/sync-health`, `/dead-letters`, `/identity-review` | Day-to-day integration health |
| Firebase console | Firestore, Functions logs                                           | Deep debugging                |
| Cloud Tasks      | `sync` queue                                                        | Stuck / poison tasks          |
| Audit log        | `auditEvents` collection                                            | Who did what                  |

Local demo: see [CUSTOMER-GUIDE.md](./CUSTOMER-GUIDE.md) for full setup → http://localhost:3100

## Sync health (`/sync-health`)

Shows `syncCursors` per facility × entity type.

| Cursor field          | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `deltaCursor`         | Last upstream modification instant successfully pulled |
| `lastDeltaRunAt`      | When delta reconciliation last ran                     |
| `lastCensusRunAt`     | When nightly census last ran                           |
| `lastSuccessAt`       | Last successful sync/reconciliation                    |
| `consecutiveFailures` | ≥3 → status `failing`                                  |
| `status`              | healthy / degraded / failing                           |

### When delta cursor is stale

1. Check Cloud Functions logs for `reconciliationDelta` errors.
2. Check PCC connection status (`pccConnections.status`, consent).
3. Check facility contract still active.
4. If webhooks also failing — likely credential or consent issue affecting both paths.

### When census hasn't run

Verify Cloud Scheduler → `reconciliationCensus` (03:00 America/New_York). Census is the **only** path that finds records never webhook-delivered.

## Dead letters (`/dead-letters`)

A dead letter means a `SyncTask` exhausted retries or failed permanently.

### Common codes

| Code                      | Likely cause                     | Fix                                                  |
| ------------------------- | -------------------------------- | ---------------------------------------------------- |
| `pcc_forbidden`           | Consent revoked or scope missing | Re-authorise connection in PCC; verify scopes        |
| `pcc_not_found`           | Patient removed upstream         | Mark resolved / ignore if expected discharge cleanup |
| `contractInactive`        | Facility contract lapsed         | Renew contract document; replay if needed            |
| `stored_document_invalid` | Schema drift                     | Engineering — fix converter/migration                |

### Replay procedure

1. Fix root cause (consent, credentials, upstream data).
2. Open dead letter in ops console.
3. Click **Replay** — calls `POST /api/dead-letters/{id}/replay` with note.
4. System sets status `replaying`, enqueues original task with `attempt=1`.
5. Verify `syncEvent` / patient document updated; dead letter → `resolved`.

**API alternative:** `POST` to `replayDeadLetter` function with Bearer token and body:

```json
{
  "deadLetterId": "dlq_…",
  "therapyOrgId": "org_healthpro",
  "note": "Reconsented in PCC portal"
}
```

Replay uses stored task envelope — not reconstructed from entity id.

### When NOT to replay

- Permanent validation error that will fail identically
- Patient legitimately deleted — resolve with note instead

## Identity review (`/identity-review`)

Pending `personMatchCandidates` where fuzzy score ≥ threshold but no authoritative link.

Reviewer sees:

- Patient id, candidate person id
- Signal breakdown (DOB, names, MRN, shared facility)
- Score — **not** full chart side-by-side in operator view

### Decision outcomes (future UI / admin API)

| Action  | Effect                                                      |
| ------- | ----------------------------------------------------------- |
| Confirm | Link patient to person; propagate to admissions             |
| Reject  | Candidate closed; new person created on next sync if needed |

Decisions must audit with `identityReview.decide` permission.

## Coverage timeline (troubleshooting)

`/patients/{id}/coverage` — sanitized payer history for billing drift debugging.

Operators see rank, payer type, effective dates, inferred closure flag — not payer names.

Clinical users with `coverage:read` may get fuller view in RehabAlpha app (separate product surface).

## Webhook troubleshooting

| Symptom                 | Check                                                    |
| ----------------------- | -------------------------------------------------------- |
| No `syncEvents`         | Webhook URL, secret, PCC subscription status             |
| Events stuck `enqueued` | Cloud Tasks queue depth, worker errors                   |
| Duplicate events        | Expected — dedupe by `messageId`; verify watermark skips |
| Out-of-order updates    | Expected — watermark policy; verify no stale overwrites  |

## Reconciliation manual trigger

Not exposed in ops UI in v1. Engineers can invoke reconciler via script or temporary HTTP admin endpoint. Scheduled jobs:

- Delta: every 15 minutes
- Census: 03:00 ET daily

## Alerting recommendations (production)

| Signal              | Threshold                | Action                        |
| ------------------- | ------------------------ | ----------------------------- |
| Open dead letters   | > 0 for 1h               | Page operator                 |
| Cursor `failing`    | consecutiveFailures ≥ 3  | Page + check PCC              |
| Worker 5xx rate     | > 1% / 5m                | Page engineering              |
| Drift records open  | growing count            | Review census output          |
| Auth grant failures | spike in `denied` audits | Possible token/grant mismatch |

## Emulator workflow (development)

```bash
npm run emulators          # start Firestore + Auth
npm run seed               # demo data
npm run test:emulator      # integration tests
npm run test:e2e           # ops console Playwright
```

E2E uses `scripts/run-e2e.mjs` to avoid shell-quoting bugs with `emulators:exec`.

## Related

- [ARCHITECTURE.md](ARCHITECTURE.md) — component flow
- [SECURITY.md](SECURITY.md) — operator permissions
- [QUESTIONS.md](QUESTIONS.md) — open PCC API questions
