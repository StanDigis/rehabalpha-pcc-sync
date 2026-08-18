import { Reconciler } from '@rehabalpha/sync';
import type { Runtime } from '../runtime.js';
import { createPccApiForConnection, createServiceLogger } from '../pcc/factory.js';

/**
 * Runs a reconciliation sweep for every facility that has an onboarded PCC connection.
 *
 * Scheduled independently of webhooks because delivery is best-effort in practice: subscriptions get
 * deactivated during maintenance, endpoints have bad deploys, messages get dropped. None of those are
 * visible from the inside.
 */
export async function runScheduledReconciliation(
  runtime: Runtime,
  mode: 'delta' | 'census',
): Promise<{ facilities: number; runs: number }> {
  const logger = createServiceLogger('reconciliation');
  const connections = await runtime.store.pccConnections().get();
  let facilities = 0;
  let runs = 0;

  for (const doc of connections.docs) {
    const connection = doc.data();
    const pcc = await createPccApiForConnection(connection, {
      config: runtime.config,
      secretStore: runtime.secretStore,
      logger,
      clock: runtime.clock,
    });

    const reconciler = new Reconciler({
      store: runtime.store,
      pcc,
      queue: runtime.queue,
      audit: runtime.audit,
      clock: runtime.clock,
      logger,
    });

    const orgFacilities = await runtime.store.listFacilitiesForOrg(connection.therapyOrgId);

    for (const facility of orgFacilities) {
      if (facility.pcc.orgUuid !== connection.pccOrgUuid) continue;
      facilities += 1;
      await reconciler.run({
        therapyOrgId: connection.therapyOrgId,
        pccOrgUuid: connection.pccOrgUuid,
        facility,
        mode,
      });
      runs += 1;
    }
  }

  return { facilities, runs };
}
