# Open questions

Items that require PCC documentation clarification, RehabAlpha product decisions, or customer legal input. These are explicit unknowns — not oversights in the reference implementation.

## PointClickCare API

### Webhooks

1. **Guaranteed delivery semantics** — at-least-once is assumed; is there a maximum retention / replay window for failed webhook deliveries?
2. **Ordering** — confirmed unordered; is `eventDateTime` always the upstream modification time suitable for watermarking?
3. **Subscription lifecycle** — who is notified when a subscription is deactivated (maintenance, consent withdrawal)?
4. **Payload completeness** — which `eventType` values imply full patient scope vs single-entity scope? Current mapping treats payer events as coverage scope.

### OAuth & consent

5. **3-legged migration timeline** — Marketplace requirement for 2026: per-facility consent UX and token storage expectations?
6. **Refresh token rotation** — does PCC rotate refresh tokens on every use? Handling concurrent workers?
7. **Scope granularity** — minimum scopes for ADT + coverage without over-broad patient access?

### Data semantics

8. **Organization master patient record** — authoritative for cross-facility identity? Edge cases when master exists but sibling not yet synced locally?
9. **Coverage end dates** — when payer disappears without `effectiveTo`, is inferred closure the correct clinical interpretation or should we poll a different endpoint?
10. **Leave of absence ADT** — canonical event sequence for LOA → return vs discharge → readmit? Fixture models one continuous stay; confirm against PCC ADT spec.
11. **Informational payers** — always non-billable? Any rank promotion without new row?

### Rate limits

12. **Published limits** — requests/minute per org vs per app? Burst vs sustained?
13. **Census sweep sizing** — maximum patients per facility page; recommended delta window?

## RehabAlpha product

14. **Clinical field ownership** — full list of fields therapists may edit that must never be overwritten by sync (partial list in `field-ownership.ts`).
15. **Discharge workflow** — when PCC shows discharged but therapy has open encounters, block sync or flag?
16. **Identity review UX** — should confirming a match require two-person rule for production?
17. **Retention** — how long to keep superseded coverage rows visible in UI vs archived?

## Legal & compliance

18. **Contract therapy data rights** — when facility contract ends, exact retention period for synced chart data (currently: stop pull, keep read).
19. **BAA with PCC** — is RehabAlpha sub-processor or is each therapy org direct PCC customer?
20. **State Medicaid billing** — payer-type-only display sufficient for operator troubleshooting under minimum necessary?

## Infrastructure

21. **Multi-region** — Firestore location vs therapy org geography; PCC API region affinity?
22. **Cloud Tasks vs Pub/Sub** — PCC or customer preference for queue technology?
23. **RTO/RPO** — acceptable chart staleness if sync paused 4h? 24h?

## How we handled unknowns in code

| Unknown                   | Current approach                             |
| ------------------------- | -------------------------------------------- |
| Unordered webhooks        | Watermark + content hash                     |
| Missing coverage end date | Close with inferred flag + drift record      |
| Fuzzy identity            | Human review queue                           |
| Webhook missed entirely   | Nightly census reconciliation                |
| API rate limits           | Token bucket + backoff; batch coverage reads |

Update this document as PCC sandbox testing or customer workshops resolve items.
