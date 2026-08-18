# Security

## Threat model (summary)

| Threat                                         | Mitigation                                                    |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Compromised client token writes chart          | **All client writes denied** in Firestore rules               |
| Cross-tenant data leak                         | `therapyOrgId` on document + rules check on every read        |
| Token valid after role revocation              | `grantVersion` in claims vs grant document                    |
| PHI in logs / DLQ                              | Redacting logger; free-text redaction on dead letters         |
| Stolen webhook endpoint                        | Shared secret header (production); IP allowlist (recommended) |
| OAuth token in Firestore                       | Credentials in Secret Manager only                            |
| Wrong person merge                             | No fuzzy auto-link; human review queue                        |
| Operator sees full chart while fixing pipeline | `integrationOperator` role excludes `patient:read`            |

## Authentication

### Firebase Auth

Users sign in via Firebase Auth (email/OIDC in production). ID token custom claims (kept small):

```json
{
  "therapyOrgId": "org_healthpro",
  "roles": ["integrationOperator"],
  "grantVersion": 3
}
```

### User grants

Full authorisation in `userGrants/{uid}`:

- `roles[]` — expanded to permissions via `ROLE_PERMISSIONS` in `@rehabalpha/core`
- `facilityIds[]` — empty means **no** facility access, not all facilities
- `disciplines[]` — therapists only
- `grantVersion` — bumped on every grant change

Server-side `authorize(grant, request)` is the single check for API routes and must mirror rules tests.

### Revocation

Custom claims cache up to ~1 hour. Bumping `grantVersion` on the grant document invalidates stale tokens immediately in both rules (`signedIn()`) and server handlers.

## Authorisation matrix

| Permission            | orgAdmin | facilityManager | therapist | biller | auditor | integrationOperator |
| --------------------- | :------: | :-------------: | :-------: | :----: | :-----: | :-----------------: |
| patient:read          |    ✓     |        ✓        |     ✓     |   ✓    |    ✓    |                     |
| coverage:read         |    ✓     |        ✓        |     ✓     |   ✓    |    ✓    |                     |
| clinical:write        |    ✓     |                 |     ✓     |        |         |                     |
| syncHealth:read       |    ✓     |        ✓        |           |        |         |          ✓          |
| deadLetter:replay     |    ✓     |                 |           |        |         |          ✓          |
| identityReview:decide |    ✓     |        ✓        |           |        |         |                     |
| auditLog:read         |    ✓     |                 |           |        |    ✓    |                     |

Ops console coverage timeline for operators shows **sanitized** fields only (rank, payer type, dates) — not payer names or member ids.

Rules suite in `tests/rules/` asserts rules agree with `ROLE_PERMISSIONS`.

## Firestore rules

Design principles (see comments in `firestore.rules`):

1. **Deny all writes** from clients — mutations only via Admin SDK (Functions, seed, controlled server routes).
2. **Tenant on document** — `sameTenant(resource.data)` on every read.
3. **Facility scope** — non–tenant-wide roles require `facilityId ∈ grant.facilityIds`.
4. **Permission helpers** — `canReadPatient()`, `canReadSyncHealth()`, etc. map to role sets.

Collection-group queries are avoided for tenant-scoped data to prevent path-based isolation gaps.

## Secrets & credentials

| Secret                   | Storage                        | Never in                   |
| ------------------------ | ------------------------------ | -------------------------- |
| OAuth client secret      | Secret Manager                 | Firestore, env (prod), git |
| Refresh token (3-legged) | Secret Manager per connection  | Firestore                  |
| Webhook shared secret    | Functions env / Secret Manager | Client                     |
| Service account keys     | GCP IAM / workload identity    | Repository                 |

`pccConnections.credentialSecretName` is a **reference**, not the credential.

Local/emulator: `InMemorySecretStore` + `PCC_TRANSPORT=fixture`.

## PHI and logging

### Structured logger (`@rehabalpha/core/logging`)

- Key-based redaction for known PHI fields
- `redactFreeText()` for upstream error messages in dead letters
- ESLint bans `console.*` outside scripts — forces logger usage

### Audit log

`auditEvents` records:

- System actions (sync applied, dead letter, identity linked)
- User actions (replay, identity decision, chart access when instrumented)

Detail objects store **field names and ids**, not demographic values.

### Dead letters

Failure messages are redacted before persistence. Full upstream response bodies are not stored.

## Network & ingress

| Endpoint           | Auth                                                  |
| ------------------ | ----------------------------------------------------- |
| `pccWebhook`       | Shared secret header + (recommended) PCC IP allowlist |
| `syncWorker`       | Cloud Tasks OIDC — service account invoker            |
| `replayDeadLetter` | Firebase ID token + `deadLetter:replay`               |
| Ops console API    | Session cookie (verified ID token)                    |

Webhook handler returns 200 quickly; no heavy work on request thread.

## HIPAA-aligned practices (engineering)

- **Minimum necessary** — integration operator role cannot read chart
- **Audit controls** — append-only audit log
- **Integrity** — watermark prevents silent chart reversion
- **Transmission** — TLS everywhere (GCP managed)

Formal BAA, retention policies, and breach procedures are organisational — out of scope for this codebase but assumed in production deployment.

## Dependency & supply chain

- Lockfile committed (`package-lock.json`)
- CI runs `npm run verify` (lint, typecheck, tests)
- No secrets in repo — `.env` gitignored

## Security testing

| Test                     | Location                               |
| ------------------------ | -------------------------------------- |
| Rules: tenant isolation  | `tests/rules/firestore-rules.test.ts`  |
| Rules: role permissions  | same                                   |
| Stale grant rejection    | same                                   |
| DLQ redaction            | `packages/sync/tests/pipeline.test.ts` |
| Authorisation unit tests | `packages/core`                        |

## Related

- [OPERATIONS.md](OPERATIONS.md) — operator procedures
- [DATA-MODEL.md](DATA-MODEL.md) — `userGrants`, audit
- [ADR.md](ADR.md) — security-related decisions
