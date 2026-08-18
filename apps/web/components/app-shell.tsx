import Link from 'next/link';
import type { ReactNode } from 'react';
import { PrimaryNav } from './primary-nav';

export function AppShell({
  children,
  email,
  tenantName,
  roles,
}: {
  children: ReactNode;
  email: string | null;
  tenantName?: string;
  roles?: string[];
}) {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <Link href="/">
            <p className="text-xs font-semibold text-teal-700 uppercase">RehabAlpha</p>
            <h1 className="text-lg font-semibold text-slate-900">Integration Ops</h1>
            {tenantName !== undefined ? (
              <p className="text-xs text-slate-500">{tenantName}</p>
            ) : null}
          </Link>
          <PrimaryNav />
          <div className="text-right text-xs text-slate-600">
            <p className="font-medium text-slate-800">{email ?? 'operator'}</p>
            {roles !== undefined && roles.length > 0 ? <p>{roles.join(', ')}</p> : null}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-6">{children}</main>
    </div>
  );
}
