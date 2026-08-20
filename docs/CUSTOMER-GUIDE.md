# Customer guide

Handover doc for reviewers and integration operators.

**Repository:** https://github.com/StanDigis/rehabalpha-pcc-sync

**Product review (read first):** [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md)  
**Architecture diagram:** https://standigis.github.io/rehabalpha-pcc-sync/site/

## Prerequisites

- Node.js ≥ 22
- JDK (Firebase emulators)
- No cloud account required for local evaluation

## Local setup

**Terminal 1 — start emulators (leave running):**

```bash
npm install
npm run emulators
```

**Terminal 2 — seed demo data and run the ops console:**

```bash
npm run seed:local
npm run dev:local
```

Open http://localhost:3100

|          |                      |
| -------- | -------------------- |
| Email    | `ops@healthpro.demo` |
| Password | `demo-password`      |

> One-shot alternative (starts emulators, seeds, exits): `npm run seed`

## Ops console

| Page         | Path                            | Purpose                                       |
| ------------ | ------------------------------- | --------------------------------------------- |
| Overview     | `/`                             | Counts: cursors, dead letters, identity queue |
| Sync health  | `/sync-health`                  | Per-facility reconciliation cursors           |
| Dead letters | `/dead-letters`                 | Failed jobs — fix upstream, then Replay       |
| Identity     | `/identity-review`              | Pending person-match candidates               |
| Coverage     | `/patients/demo-betty/coverage` | Sanitized payer timeline (demo)               |

Operator runbooks: [OPERATIONS.md](./OPERATIONS.md)

## Documentation

| Doc                                              | Contents                     |
| ------------------------------------------------ | ---------------------------- |
| [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md) | Real-world scenarios         |
| [CUTOVER.md](./CUTOVER.md)                       | Rollout with existing charts |
| [DATA-MAPPING.md](./DATA-MAPPING.md)             | PCC → RehabAlpha fields      |
| [ARCHITECTURE.md](./ARCHITECTURE.md)             | Components, data flow        |
| [DATA-MODEL.md](./DATA-MODEL.md)                 | Firestore schema             |
| [SECURITY.md](./SECURITY.md)                     | Auth and rules               |
| [OPERATIONS.md](./OPERATIONS.md)                 | Runbooks                     |
| [QUESTIONS.md](./QUESTIONS.md)                   | Open items                   |
| [ADR.md](./ADR.md)                               | Decision records             |

## Verification

```bash
npm run verify
npm run test:e2e
```

Expected: 225 unit tests, 101 emulator integration tests, 1 Playwright E2E — all pass.

## Acceptance checklist

- [ ] Clone repo, `npm install` succeeds
- [ ] `npm run emulators` starts Firestore + Auth
- [ ] `npm run seed:local` completes
- [ ] Console at http://localhost:3100 — login works, overview shows metrics
- [ ] Sync health, dead letters, identity, Betty coverage pages render
- [ ] [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md) reviewed
- [ ] `npm run verify` and `npm run test:e2e` pass

## Out of scope

Production GCP deployment, real PCC credentials, and RehabAlpha clinical UI integration are not included. See [QUESTIONS.md](./QUESTIONS.md).
