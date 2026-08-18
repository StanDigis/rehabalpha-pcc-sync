import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { EmptyState, Mono, PageHeader, Panel, StatusBadge } from '@/components/ui';
import { getSession, requirePermission } from '@/lib/auth';
import { formatAge, listPendingIdentityReviews } from '@/lib/queries';

export default async function IdentityReviewPage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  try {
    requirePermission(session, 'identityReview:read');
  } catch {
    redirect('/login');
  }

  const rows = await listPendingIdentityReviews(session.user.therapyOrgId);

  return (
    <AppShell email={session.user.email}>
      <PageHeader
        title="Identity review"
        description="Probabilistic matches never auto-link. Reviewers see signal strength without opening full charts."
      />

      <Panel>
        {rows.length === 0 ? (
          <EmptyState
            title="Nothing pending"
            detail="No identity candidates awaiting a decision."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-3">Patient</th>
                  <th className="px-4 py-3">Candidate person</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Signals</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top hover:bg-slate-50/80">
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
                      <ul className="space-y-1">
                        <li>DOB: {row.signals.birthDateMatches ? 'match' : 'no'}</li>
                        <li>Last name: {row.signals.lastNameMatches ? 'match' : 'no'}</li>
                        <li>
                          First name similarity:{' '}
                          {(row.signals.firstNameSimilarity * 100).toFixed(0)}%
                        </li>
                        <li>MRN: {row.signals.medicalRecordNumberMatches ? 'match' : 'no'}</li>
                        <li>Shared facility: {row.signals.sharesFacility ? 'yes' : 'no'}</li>
                      </ul>
                    </td>
                    <td className="px-4 py-3">{formatAge(row.createdAt)}</td>
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
