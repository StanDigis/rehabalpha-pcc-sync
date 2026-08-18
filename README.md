# RehabAlpha ↔ PointClickCare Sync

Production-grade reference implementation for synchronising patient demographics, admissions, and coverage from **PointClickCare (PCC)** into **RehabAlpha** for contract therapy organisations.

This is an **architecture challenge submission**, not a greenfield CRUD app. The deliverable is a working integration with explicit trade-offs, security boundaries, operational tooling, and test evidence.

## Problem in one paragraph

Betty breaks her hip and is admitted to Ferncrest SNF. Her chart lives in PCC — demographics, stay, payers. HealthPRO (a contract therapy company using RehabAlpha) needs the same facts for documentation and billing, but today someone re-types them. The integration makes PCC the source of truth for those fields, keeps RehabAlpha's clinical documentation separate, and handles the messy reality: duplicate webhooks, out-of-order delivery, payer transitions, leave-of-absence stays, and the same human appearing at a second facility under a new medical record number.

## Repository layout

```
rehabalpha-pcc-sync/
├── packages/core         Domain schemas, policies (watermark, coverage timeline, identity)
├── packages/pcc-client   OAuth 2/3-legged client, rate limit, retries, fixtures
├── packages/sync         Ingest, worker, reconciliation, Firestore store, audit log
├── apps/functions        Cloud Functions v2: webhook, worker, schedules, operator replay
├── apps/web              Integration ops console (Next.js)
├── docs/                 Architecture and operations documentation
├── docs/site/            Interactive architecture visualisation (GitHub Pages)
├── scripts/              Emulator helpers, seed, E2E runner
├── firestore.rules       Deny-by-default, read-only client access
└── tests/rules/          Firestore rules unit tests
```

## Quick start (local, emulator only)

Requires **Node ≥ 22** and a JDK (for Firebase emulators).

```bash
npm install
npm run seed          # demo tenant + Betty + DLQ + operator user
npm run dev:web       # ops console at http://localhost:3100
npm run emulators     # Firestore + Auth emulators (standalone)
```

Demo operator: `ops@healthpro.demo` / `demo-password` (Auth emulator).

`PCC_TRANSPORT=fixture` is enforced for local/CI — the client refuses to call the real PCC API without an explicit override.

## Verification

```bash
npm run verify        # format + lint + typecheck + all tests
npm run test          # 225 unit tests
npm run test:emulator # 101 integration tests (sync + functions + rules)
npm run test:e2e      # Playwright against emulator + seed
```

## Documentation

| Document                                  | Contents                                                    |
| ----------------------------------------- | ----------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)   | Components, data flow, reconciliation, failure modes        |
| [DATA-MODEL.md](docs/DATA-MODEL.md)       | Firestore collections, bitemporal coverage, identity        |
| [SECURITY.md](docs/SECURITY.md)           | Auth, grants, PHI logging, secrets, rules                   |
| [OPERATIONS.md](docs/OPERATIONS.md)       | Runbooks: DLQ replay, sync health, identity queue           |
| [QUESTIONS.md](docs/QUESTIONS.md)         | Open questions for PCC / RehabAlpha product                 |
| [ADR.md](docs/ADR.md)                     | Architecture decision records                               |
| [Architecture site](docs/site/index.html) | Interactive diagram — deploy via GitHub Pages (`docs/site`) |

## Key design choices (summary)

- **Webhook fast-ack + Cloud Tasks worker** — PCC expects a response in seconds; sync re-reads upstream state in the worker rather than trusting the webhook body.
- **Watermark policy** — at-least-once, out-of-order delivery safe without global ordering.
- **Bitemporal coverage** — never delete payer rows; close with end dates; auditable payer transitions.
- **Identity** — authoritative PCC master patient or exact MRN only; fuzzy matches go to human review.
- **Flat Firestore collections + `therapyOrgId`** — cross-facility ops queries without collection-group tenant leaks.
- **Deny client writes** — all mutations via Admin SDK / authenticated server endpoints.

## Licence

Reference implementation for evaluation purposes.
