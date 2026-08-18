import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { Alert, BackLink, PageHeader } from '@/components/ui';
import { getSession } from '@/lib/auth';
import { loadOpsOverview } from '@/lib/queries';

export default async function HomePage() {
  const session = await getSession();
  if (session === null) redirect('/login');

  const overview = await loadOpsOverview(session.user.therapyOrgId);
  const staleCount = overview.cursorDegraded + overview.cursorFailing;

  const alertTone =
    overview.overallStatus === 'healthy'
      ? 'success'
      : overview.overallStatus === 'attention'
        ? 'warn'
        : 'danger';

  return (
    <AppShell
      email={session.user.email}
      tenantName={overview.tenantName}
      roles={session.grant.roles}
    >
      <PageHeader
        title="Sync overview"
        description="PCC → RehabAlpha integration status for this therapy org."
      />

      <div className="flex flex-col gap-6">
        <Alert tone={alertTone}>{overview.headline}</Alert>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: 'Healthy cursors', value: overview.cursorHealthy, href: '/sync-health' },
            { label: 'Stale / failing', value: staleCount, href: '/sync-health' },
            { label: 'Dead letters', value: overview.deadLetters, href: '/dead-letters' },
            { label: 'Identity queue', value: overview.identityPending, href: '/identity-review' },
          ].map((item) => (
            <Link
              key={item.label}
              href={item.href}
              className="rounded-lg border border-slate-200 bg-white p-4"
            >
              <p className="text-xs font-medium text-slate-500 uppercase">{item.label}</p>
              <p className="mt-1 text-3xl font-semibold text-slate-900 tabular-nums">
                {item.value}
              </p>
            </Link>
          ))}
        </div>

        <p className="text-sm text-slate-600">
          Demo data:{' '}
          <Link href="/dead-letters" className="text-teal-700 hover:underline">
            dead letter replay
          </Link>
          {' · '}
          <Link href="/identity-review" className="text-teal-700 hover:underline">
            identity match
          </Link>
          {' · '}
          <Link href="/patients/demo-betty/coverage" className="text-teal-700 hover:underline">
            Betty coverage
          </Link>
          . Runbook: <code className="text-xs">docs/OPERATIONS.md</code>.
        </p>
      </div>
    </AppShell>
  );
}
