import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { ReplayDeadLetterButton } from '@/components/replay-dead-letter-button';
import { EmptyState, Mono, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { getSession, requirePermission } from '@/lib/auth';
import { formatAge, listOpenDeadLetters } from '@/lib/queries';

export default async function DeadLettersPage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  try {
    requirePermission(session, 'deadLetter:read');
  } catch {
    redirect('/login');
  }

  const rows = await listOpenDeadLetters(session.user.therapyOrgId);
  const canReplay = session.grant.roles.some((role) =>
    ['orgAdmin', 'integrationOperator'].includes(role),
  );

  return (
    <AppShell email={session.user.email}>
      <PageHeader
        title="Dead letters"
        description="Units of sync work that exhausted retries or failed permanently. Replay after fixing consent, credentials, or upstream data."
      />

      <Panel>
        {rows.length === 0 ? (
          <EmptyState title="Queue is clear" detail="No open dead letters for this tenant." />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Entity</th>
                  <th className="px-4 py-3">Failure</th>
                  <th className="px-4 py-3">Attempts</th>
                  <th className="px-4 py-3">Last failed</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-slate-50/80">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900 capitalize">{row.entityType}</p>
                      <Mono>{row.entityPccId}</Mono>
                      {row.facilityName !== null ? (
                        <p className="mt-1 text-xs text-slate-500">{row.facilityName}</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">{row.failure.code}</p>
                      <p className="mt-1 max-w-md text-xs text-slate-500">{row.failure.message}</p>
                    </td>
                    <td className="px-4 py-3">{row.failure.attempts}</td>
                    <td className="px-4 py-3">{formatAge(row.failure.lastFailedAt)}</td>
                    <td className="px-4 py-3">
                      <StatusBadge tone={row.status === 'replaying' ? 'warn' : 'danger'}>
                        {row.status}
                      </StatusBadge>
                    </td>
                    <td className="px-4 py-3">
                      {canReplay ? (
                        <ReplayDeadLetterButton
                          deadLetterId={row.id}
                          therapyOrgId={session.user.therapyOrgId}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </AppShell>
  );
}
