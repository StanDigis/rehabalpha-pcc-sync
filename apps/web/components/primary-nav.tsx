'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/', label: 'Overview' },
  { href: '/sync-health', label: 'Sync health' },
  { href: '/dead-letters', label: 'Dead letters' },
  { href: '/identity-review', label: 'Identity' },
] as const;

export function PrimaryNav() {
  const pathname = usePathname();

  return (
    <nav className="flex flex-wrap items-center gap-1">
      {links.map((link) => {
        const active =
          link.href === '/'
            ? pathname === '/'
            : pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              active
                ? 'bg-teal-700 text-white'
                : 'text-slate-600 hover:bg-white hover:text-slate-900'
            }`}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
