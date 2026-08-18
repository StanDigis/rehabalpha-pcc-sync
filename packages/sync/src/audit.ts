import { redact, type AuditEvent, type Clock } from '@rehabalpha/core';
import type { Transaction } from 'firebase-admin/firestore';
import type { SyncStore } from './firestore/store.js';

export type AuditInput = {
  therapyOrgId: string;
  facilityId: string | null;
  actor: AuditEvent['actor'];
  action: string;
  target: AuditEvent['target'];
  outcome: AuditEvent['outcome'];
  correlationId: string | null;
  detail?: Record<string, unknown>;
};

/**
 * Append-only audit log.
 *
 * Written inside the same transaction as the change it describes wherever possible. An audit
 * record that can be missing when the write succeeded is not an audit record — the two must
 * commit or fail together, otherwise the log is only mostly true and cannot be relied on to answer
 * "who changed this" during an investigation.
 *
 * `detail` is passed through redaction on the way in. The log needs to say that
 * `demographics.lastName` changed; it must not say what it changed to. Field names and identifiers
 * are enough to explain a change, and keeping values out means the audit collection does not
 * become the largest unmanaged store of PHI in the system.
 */
export class AuditLog {
  constructor(
    private readonly store: SyncStore,
    private readonly clock: Clock,
    private readonly service: string,
  ) {}

  private build(input: AuditInput): AuditEvent {
    return {
      id: '',
      therapyOrgId: input.therapyOrgId,
      facilityId: input.facilityId,
      at: this.clock.now(),
      actor: input.actor,
      action: input.action,
      target: input.target,
      outcome: input.outcome,
      correlationId: input.correlationId,
      detail: (redact(input.detail ?? {}) as Record<string, unknown>) ?? {},
    };
  }

  async record(input: AuditInput): Promise<void> {
    const ref = this.store.auditEvents().doc();
    await ref.set({ ...this.build(input), id: ref.id });
  }

  recordIn(tx: Transaction, input: AuditInput): void {
    const ref = this.store.auditEvents().doc();
    tx.set(ref, { ...this.build(input), id: ref.id });
  }

  /** Convenience for system-actor entries, which is the majority of sync traffic. */
  system(input: Omit<AuditInput, 'actor'>): AuditInput & { actor: AuditEvent['actor'] } {
    return { ...input, actor: { kind: 'system', uid: null, service: this.service } };
  }
}
