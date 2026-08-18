import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import {
  BackLink,
  DataTable,
  EmptyState,
  Mono,
  PageHeader,
  Panel,
  StatusBadge,
  TableHead,
} from '@/components/ui';
import { getSession, requirePermission } from '@/lib/auth';
import { formatAge, listSyncHealth, loadOpsOverview } from '@/lib/queries';

function cursorTone(status: 'healthy' | 'degraded' | 'failing'): 'ok' | 'warn' | 'danger' {
  if (status === 'healthy') return 'ok';
  if (status === 'degraded') return 'warn';
  return 'danger';
}

export default async function SyncHealthPage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  try {
    requirePermission(session, 'syncHealth:read');
  } catch {
    redirect('/login');
  }

  const [rows, overview] = await Promise.all([
    listSyncHealth(session.user.therapyOrgId),
    loadOpsOverview(session.user.therapyOrgId),
  ]);

  return (
    <AppShell
      email={session.user.email}
      tenantName={overview.tenantName}
      roles={session.grant.roles}
    >
      <PageHeader
        title="Sync health"
        description="Reconciliation cursors per facility and entity type."
        actions={<BackLink />}
      />

      <Panel title="Facility cursors">
        {rows.length === 0 ? (
          <EmptyState
            title="No cursors"
            detail="Run seed against the emulator or wait for the first reconciliation sweep."
          />
        ) : (
          <DataTable>
            <TableHead>
              <tr>
                <th className="px-4 py-2">Facility</th>
                <th className="px-4 py-2">Entity</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Delta cursor</th>
                <th className="px-4 py-2">Last success</th>
                <th className="px-4 py-2">Failures</th>
              </tr>
            </TableHead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">{row.facilityName}</p>
                    <Mono>{row.facilityId}</Mono>
                  </td>
                  <td className="px-4 py-3 capitalize">{row.entityType}</td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={cursorTone(row.status)}>{row.status}</StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.deltaCursor === null ? '—' : formatAge(row.deltaCursor)}
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {row.lastSuccessAt === null ? '—' : formatAge(row.lastSuccessAt)}
                  </td>
                  <td className="px-4 py-3">{row.consecutiveFailures}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>
    </AppShell>
  );
}
