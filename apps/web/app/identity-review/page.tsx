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
import { formatAge, listPendingIdentityReviews, loadOpsOverview } from '@/lib/queries';

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

export default async function IdentityReviewPage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  try {
    requirePermission(session, 'identityReview:read');
  } catch {
    redirect('/login');
  }

  const [rows, overview] = await Promise.all([
    listPendingIdentityReviews(session.user.therapyOrgId),
    loadOpsOverview(session.user.therapyOrgId),
  ]);

  return (
    <AppShell
      email={session.user.email}
      tenantName={overview.tenantName}
      roles={session.grant.roles}
    >
      <PageHeader
        title="Identity review"
        description="Pending person-match candidates. Fuzzy matches are never auto-linked."
        actions={<BackLink />}
      />

      <Panel title="Pending">
        {rows.length === 0 ? (
          <EmptyState
            title="Queue empty"
            detail="Candidates appear when sync finds similar demographics without an authoritative PCC link."
          />
        ) : (
          <DataTable>
            <TableHead>
              <tr>
                <th className="px-4 py-2">Patient</th>
                <th className="px-4 py-2">Candidate</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Signals</th>
                <th className="px-4 py-2">Created</th>
              </tr>
            </TableHead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-4 py-3">
                    <Mono>{row.patientId}</Mono>
                  </td>
                  <td className="px-4 py-3">
                    <Mono>{row.candidatePersonId}</Mono>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge tone={row.score >= 0.85 ? 'warn' : 'neutral'}>
                      {(row.score * 100).toFixed(0)}%
                    </StatusBadge>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    <ul className="space-y-0.5">
                      <li>DOB: {yesNo(row.signals.birthDateMatches)}</li>
                      <li>Last name: {yesNo(row.signals.lastNameMatches)}</li>
                      <li>First name: {(row.signals.firstNameSimilarity * 100).toFixed(0)}%</li>
                      <li>MRN: {yesNo(row.signals.medicalRecordNumberMatches)}</li>
                      <li>Shared facility: {yesNo(row.signals.sharesFacility)}</li>
                    </ul>
                  </td>
                  <td className="px-4 py-3">{formatAge(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </Panel>
    </AppShell>
  );
}
