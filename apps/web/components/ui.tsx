import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-3xl">
        <h2 className="text-2xl font-semibold text-slate-900">{title}</h2>
        {description !== undefined ? (
          <p className="mt-2 text-sm leading-6 text-slate-600">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function BackLink({ href = '/' }: { href?: string }) {
  return (
    <Link
      href={href}
      className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
    >
      Back
    </Link>
  );
}

export function Panel({
  children,
  className = '',
  title,
  subtitle,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
}) {
  return (
    <section className={`overflow-hidden rounded-lg border border-slate-200 bg-white ${className}`}>
      {title !== undefined ? (
        <div className="border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-medium text-slate-900">{title}</h3>
          {subtitle !== undefined ? (
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          ) : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-6 py-12 text-center">
      <p className="text-sm font-medium text-slate-900">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">{detail}</p>
      {action !== undefined ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  children: ReactNode;
}) {
  const styles = {
    ok: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    warn: 'bg-amber-50 text-amber-900 ring-amber-200',
    danger: 'bg-rose-50 text-rose-800 ring-rose-200',
    neutral: 'bg-slate-50 text-slate-700 ring-slate-200',
  } as const;

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="font-mono text-xs text-slate-600">{children}</span>;
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'success' | 'warn' | 'danger';
  children: ReactNode;
}) {
  const styles = {
    info: 'border-slate-200 bg-slate-50 text-slate-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    danger: 'border-rose-200 bg-rose-50 text-rose-900',
  } as const;

  return (
    <div className={`rounded-md border px-4 py-3 text-sm leading-6 ${styles[tone]}`}>
      {children}
    </div>
  );
}

const tableClass = 'min-w-full divide-y divide-slate-100 text-sm';
const theadClass = 'bg-slate-50 text-left text-xs uppercase text-slate-500';

export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className={tableClass}>{children}</table>
    </div>
  );
}

export function TableHead({ children }: { children: ReactNode }) {
  return <thead className={theadClass}>{children}</thead>;
}
