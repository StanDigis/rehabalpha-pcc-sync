import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { getSession } from '@/lib/auth';

export default async function LoginPage() {
  const session = await getSession();
  if (session !== null) {
    redirect('/sync-health');
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold tracking-[0.2em] text-teal-700 uppercase">RehabAlpha</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Operator sign-in</h1>
        <p className="mt-2 text-sm text-slate-600">
          Integration operators can inspect sync health and replay dead letters without chart
          access.
        </p>
        <div className="mt-8">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
