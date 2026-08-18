# Customer guide

Handover doc for reviewers and integration operators.

**Repository:** [StanDigis/rehabalpha-pcc-sync](https://github.com/StanDigis/rehabalpha-pcc-sync)

## Prerequisites

- Node.js ≥ 22
- JDK (Firebase emulators)
- No cloud account required for local evaluation

## Local setup

**Terminal 1:**

```bash
npm run emulators
```

**Terminal 2:**

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export GCLOUD_PROJECT=rehabalpha-pcc-sync-demo
export NEXT_PUBLIC_USE_FIREBASE_EMULATOR=true
export OPS_CONSOLE_DEV_BYPASS=1

npm run seed:run
npm run dev:web
```

Open http://localhost:3100

|          |                      |
| -------- | -------------------- |
| Email    | `ops@healthpro.demo` |
| Password | `demo-password`      |

## Ops console

| Page         | Path                            | Purpose                                       |
| ------------ | ------------------------------- | --------------------------------------------- |
| Overview     | `/`                             | Counts: cursors, dead letters, identity queue |
| Sync health  | `/sync-health`                  | Per-facility reconciliation cursors           |
| Dead letters | `/dead-letters`                 | Failed jobs — fix upstream, then Replay       |
| Identity     | `/identity-review`              | Pending person-match candidates               |
| Coverage     | `/patients/demo-betty/coverage` | Sanitized payer timeline (demo)               |

Operator procedures and failure codes: [OPERATIONS.md](./OPERATIONS.md)

### Seed demo scenarios

- **Dead letter:** Betty · `pcc_forbidden` — replay after reading failure message
- **Identity:** ~78% match with signal breakdown
- **Coverage:** Medicare → Medicaid rows for Betty

## Verification

With emulators running:

```bash
npm run verify
```

Expected: all tests pass (225 unit, 101 emulator integration, 1 Playwright E2E).

## Documentation map

| Doc                                       | Use when…                              |
| ----------------------------------------- | -------------------------------------- |
| [ARCHITECTURE.md](./ARCHITECTURE.md)      | Understanding components and data flow |
| [DATA-MODEL.md](./DATA-MODEL.md)          | Firestore collections and indexes      |
| [SECURITY.md](./SECURITY.md)              | Auth model and Firestore rules         |
| [OPERATIONS.md](./OPERATIONS.md)          | Runbooks and on-call                   |
| [QUESTIONS.md](./QUESTIONS.md)            | Known open items                       |
| [ADR.md](./ADR.md)                        | Decision rationale                     |
| [docs/site/index.html](./site/index.html) | Visual architecture overview           |

## Acceptance checklist

- [ ] `npm install` succeeds
- [ ] Emulators start; seed completes
- [ ] Console login works; overview shows metrics
- [ ] Sync health, dead letters, identity, Betty coverage render
- [ ] `npm run verify` passes
- [ ] Architecture docs reviewed

## Out of scope

This submission does not include production GCP deployment, real PCC credentials, or RehabAlpha clinical UI integration. See [QUESTIONS.md](./QUESTIONS.md) for follow-up items.
