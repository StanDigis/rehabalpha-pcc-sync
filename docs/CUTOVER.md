# Cutover — enabling sync when RehabAlpha already has data

Runbook for turning on PointClickCare sync at a facility that **already has patients** in RehabAlpha (manually entered, imported, or partially synced).

---

## Assumptions

- Contract therapy org has an active `facilityContract` for the SNF.
- PCC OAuth connection is healthy (`pccConnections.status = healthy`).
- Webhook subscription is registered for the facility.
- Therapists may already have documentation tied to existing RehabAlpha patient ids.

---

## What cutover is not

| Misconception                                    | Reality                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| "Turn on sync and PCC replaces everything"       | Only PCC-owned fields on synced documents update; clinical docs are untouched |
| "Duplicate PCC ids will create duplicate charts" | Stable ids + dedupe prevent this for the same PCC patient                     |
| "Fuzzy name match auto-merges"                   | Scores ≥ 55% go to identity review queue; human confirms                      |
| "Missing in PCC means delete locally"            | `missingUpstream` drift → operator decision, never auto-delete                |

---

## Phases

### Phase 0 — Inventory (before go-live)

1. Export existing RehabAlpha patients for the facility (id, name, DOB, MRN if stored).
2. Confirm which charts have **submitted claims** or **open encounters** — these constrain how aggressively you relink identity.
3. Agree cutover window with facility (low census period preferred).

**Deliverable:** spreadsheet or report: RehabAlpha id ↔ expected PCC patient id (where known).

### Phase 1 — Connection and webhook (T-1 day)

1. Verify `pccConnections` consent and scopes for the facility.
2. Register webhook subscription pointing at `pccWebhook` endpoint.
3. Run manual sync for **one test patient** in a sandbox or single MRN.
4. Confirm ops console `/sync-health` shows healthy cursor.

No bulk pull yet — validate plumbing.

### Phase 2 — Initial census (T-0)

1. Trigger **census reconciliation** for the facility (`reconciliationCensus` schedule, or manual run).
2. Census compares PCC patient id set vs local `patients` with matching `pcc.patientId`.
3. For each PCC patient not yet local: enqueue full sync (`scope: all`).
4. For each local patient with no PCC id yet: remains until identity links or new PCC patient appears.

**Expected load:** proportional to facility census; rate-limited via PCC client token bucket.

Monitor: `/sync-health` cursors, Cloud Functions logs, dead letter queue.

### Phase 3 — Identity reconciliation (T-0 → T+3 days)

For each new `patients` row created from PCC:

| Signal                  | Action                                    |
| ----------------------- | ----------------------------------------- |
| PCC master patient link | Auto-link to existing `person`            |
| Exact MRN at facility   | Auto-link                                 |
| Fuzzy match ≥ 55%       | `personMatchCandidates` → operator review |
| No match                | New `person` created                      |

**Operator workflow:** `/identity-review` — confirm or reject with signal breakdown.

**Critical:** Do not bulk-confirm matches during cutover without reviewing signals. One wrong link affects payer and caseload for all facilities sharing that `person`.

Existing RehabAlpha charts **without** a PCC patient id remain valid. They receive PCC data only after:

- Manual link decision confirms same person, or
- Therapist maps chart in product UI (future — hook is `personMatchCandidates` + audit), or
- New PCC patient is recognised as net-new (new `person`).

See [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md) scenario 1.

### Phase 4 — Steady state (T+3 days onward)

| Mechanism             | Interval         | Purpose                       |
| --------------------- | ---------------- | ----------------------------- |
| Webhooks              | Real time        | Primary change path           |
| Delta reconciliation  | Every 15 min     | Catch missed webhooks         |
| Census reconciliation | Nightly 03:00 ET | Catch never-delivered records |
| Ops review            | Daily first week | Dead letters + identity queue |

---

## Admission and payer alignment after identity link

When an operator **confirms** a person match:

1. `patient.personId` and `personLink` are set (RehabAlpha-owned — not overwritten by later sync).
2. Next admission sync copies `personId` to all stays for that patient.
3. Coverage sync attaches to `currentAdmissionId` when scope includes coverage.

If two PCC patient ids merge to one person, **each id retains its own ADT-derived admissions** until product defines a merge policy for conflicting stays ([QUESTIONS.md](./QUESTIONS.md)).

---

## Drift handling during cutover

`driftRecords` raised by census/delta:

| Kind                 | Typical cutover cause                 | Action                                              |
| -------------------- | ------------------------------------- | --------------------------------------------------- |
| `missingLocally`     | Missed webhook                        | Auto-repaired by enqueue                            |
| `fieldMismatch`      | Manual RehabAlpha edit vs PCC         | Auto-repair PCC-owned fields unless override active |
| `missingUpstream`    | Discharged in PCC, still open locally | **Human** — may be valid lag or data issue          |
| `watermarkInversion` | Clock skew / bug                      | Investigate, never auto-repair                      |

---

## Rollback

Sync is **additive and idempotent** for PCC-owned fields. Rollback options:

1. **Stop pull:** set `facilityContract.status = terminated` — sync skips facility; existing data retained for claims.
2. **Revoke consent:** PCC connection → `revoked`; new pulls fail; charts frozen at last good sync.
3. **Identity mistake:** operator rejects link or soft-merge persons (`mergedIntoPersonId`) — requires runbook in production product.

There is no "delete all synced data" button — retention follows contract and regulatory requirements.

---

## Demo in this repository

```bash
npm run emulators          # terminal 1
npm run seed:local         # terminal 2 — Betty + identity candidate + dead letter
npm run dev:local          # ops console
```

Seed simulates post-cutover state: linked patient, pending identity match, failed sync, payer transition.

---

## Checklist

- [ ] Facility contract active
- [ ] PCC connection healthy, webhook subscribed
- [ ] Pre-cutover inventory exported
- [ ] Census run completed; cursors healthy
- [ ] Identity queue reviewed (no bulk auto-confirm)
- [ ] Dead letters cleared or documented
- [ ] Therapists notified: PCC owns demographics/payers; documentation stays in RehabAlpha
- [ ] First-week daily ops review scheduled

---

## Related documents

- [BUSINESS-SCENARIOS.md](./BUSINESS-SCENARIOS.md)
- [DATA-MAPPING.md](./DATA-MAPPING.md)
- [OPERATIONS.md](./OPERATIONS.md)
