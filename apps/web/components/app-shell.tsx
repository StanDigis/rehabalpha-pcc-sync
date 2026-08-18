import Link from 'next/link';
import type { ReactNode } from 'react';

const links = [
  { href: '/sync-health', label: 'Sync health' },
  { href: '/dead-letters', label: 'Dead letters' },
  { href: '/identity-review', label: 'Identity review' },
] as const;

export function AppShell({ children, email }: { children: ReactNode; email: string | null }) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-4">
          <div>
            <p className="text-xs font-semibold tracking-[0.2em] text-teal-700 uppercase">
              RehabAlpha
            </p>
            <h1 className="text-lg font-semibold text-slate-900">Integration Ops Console</h1>
          </div>
          <nav className="flex flex-wrap items-center gap-4 text-sm font-medium text-slate-600">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-md px-2 py-1 transition hover:bg-slate-100 hover:text-slate-900"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="text-right text-xs text-slate-500">
            <p className="font-medium text-slate-700">{email ?? 'operator'}</p>
            <p>integrationOperator</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
    </div>
  );
}
