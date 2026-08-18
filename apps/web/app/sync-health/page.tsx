import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { EmptyState, Mono, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { getSession, requirePermission } from '@/lib/auth';
import { formatAge, listSyncHealth } from '@/lib/queries';

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

  const rows = await listSyncHealth(session.user.therapyOrgId);

  return (
    <AppShell email={session.user.email}>
      <PageHeader
        title="Sync health"
        description="Per-facility reconciliation cursors. A stale delta cursor usually means missed webhooks; census catches records never delivered."
      />

      <Panel>
        {rows.length === 0 ? (
          <EmptyState
            title="No cursors yet"
            detail="Run reconciliation or seed demo data to populate facility sync state."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Facility</th>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Delta cursor</th>
                  <th className="px-4 py-3">Last success</th>
                  <th className="px-4 py-3">Failures</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{row.facilityName}</p>
                      <Mono>{row.facilityId}</Mono>
                    </td>
                    <td className="px-4 py-3 capitalize">{row.entityType}</td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={cursorTone(row.status)}>{row.status}</StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      {row.deltaCursor === null ? '—' : formatAge(row.deltaCursor)}
                    </td>
                    <td className="px-4 py-3">
                      {row.lastSuccessAt === null ? '—' : formatAge(row.lastSuccessAt)}
                    </td>
                    <td className="px-4 py-3">{row.consecutiveFailures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="mt-6 text-sm text-slate-500">
        Coverage timelines for troubleshooting payer drift:{' '}
        <Link href="/patients/demo-betty/coverage" className="font-medium text-teal-700 underline">
          open sanitized Betty timeline
        </Link>
        .
      </p>
    </AppShell>
  );
}
