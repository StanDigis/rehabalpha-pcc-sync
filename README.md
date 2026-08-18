# RehabAlpha ↔ PointClickCare Sync

Reference implementation: sync patient demographics, admissions, and coverage from **PointClickCare (PCC)** into **RehabAlpha** for contract therapy organisations.

## Repository layout

```
rehabalpha-pcc-sync/
├── packages/core         Domain schemas and sync policies
├── packages/pcc-client   OAuth client, rate limit, retries, fixtures
├── packages/sync         Ingest, worker, reconciliation, Firestore store
├── apps/functions        Cloud Functions v2 (webhook, worker, schedules)
├── apps/web              Integration ops console (Next.js)
├── docs/                 Architecture and operations docs
├── scripts/              Seed, emulator helpers, E2E runner
└── firestore.rules       Deny-by-default security rules
```

## Quick start

Requires Node ≥ 22 and a JDK (Firebase emulators).

```bash
npm install
npm run emulators     # terminal 1
npm run seed:run      # terminal 2 (with emulator env — see CUSTOMER-GUIDE)
npm run dev:web       # http://localhost:3100
```

Demo operator: `ops@healthpro.demo` / `demo-password`

`PCC_TRANSPORT=fixture` is enforced locally — no real PCC API calls without an explicit override.

## Verification

```bash
npm run verify        # format, lint, typecheck, all tests
```

## Documentation

| Document                                     | Contents                                   |
| -------------------------------------------- | ------------------------------------------ |
| [CUSTOMER-GUIDE.md](docs/CUSTOMER-GUIDE.md)  | Setup, console usage, acceptance checklist |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)      | Components, data flow, failure modes       |
| [OPERATIONS.md](docs/OPERATIONS.md)          | Operator runbooks                          |
| [DATA-MODEL.md](docs/DATA-MODEL.md)          | Firestore schema                           |
| [SECURITY.md](docs/SECURITY.md)              | Auth, grants, rules                        |
| [QUESTIONS.md](docs/QUESTIONS.md)            | Open items for PCC / product               |
| [ADR.md](docs/ADR.md)                        | Architecture decisions                     |
| [docs/site/index.html](docs/site/index.html) | Architecture diagram                       |

## Design summary

- Webhook fast-ack + Cloud Tasks worker (re-read upstream in worker)
- Watermark policy for at-least-once / out-of-order delivery
- Bitemporal coverage rows (no deletes)
- Identity: authoritative PCC link or exact MRN only; fuzzy → human review
- Flat Firestore collections scoped by `therapyOrgId`
- Client writes denied; mutations via Admin SDK / server endpoints
