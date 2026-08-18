import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { ReplayDeadLetterButton } from '@/components/replay-dead-letter-button';
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
import { formatAge, listOpenDeadLetters, loadOpsOverview } from '@/lib/queries';

export default async function DeadLettersPage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  try {
    requirePermission(session, 'deadLetter:read');
  } catch {
    redirect('/login');
  }

  const [rows, overview] = await Promise.all([
    listOpenDeadLetters(session.user.therapyOrgId),
    loadOpsOverview(session.user.therapyOrgId),
  ]);

  const canReplay = session.grant.roles.some((role) =>
    ['orgAdmin', 'integrationOperator'].includes(role),
  );

  return (
    <AppShell
      email={session.user.email}
      tenantName={overview.tenantName}
      roles={session.grant.roles}
    >
      <PageHeader
        title="Dead letters"
        description="Failed sync jobs awaiting operator replay."
        actions={<BackLink />}
      />

      <Panel title="Open">
        {rows.length === 0 ? (
          <EmptyState
            title="Queue empty"
            detail="Dead letters appear after retries are exhausted or PCC returns a permanent error."
            action={
              <Link href="/sync-health" className="text-sm text-teal-700 hover:underline">
                Sync health
              </Link>
            }
          />
        ) : (
          <DataTable>
            <TableHead>
              <tr>
                <th className="px-4 py-2">Entity</th>
                <th className="px-4 py-2">Failure</th>
                <th className="px-4 py-2">Attempts</th>
                <th className="px-4 py-2">Last failed</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </TableHead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium capitalize">{row.entityType}</p>
                    <Mono>{row.entityPccId}</Mono>
                    {row.facilityName !== null ? (
                      <p className="mt-1 text-xs text-slate-500">{row.facilityName}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{row.failure.code}</p>
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
          </DataTable>
        )}
      </Panel>
    </AppShell>
  );
}
