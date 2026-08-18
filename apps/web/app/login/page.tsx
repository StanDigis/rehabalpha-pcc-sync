import { redirect } from 'next/navigation';
import { LoginForm } from '@/components/login-form';
import { getSession } from '@/lib/auth';

export default async function LoginPage() {
  const session = await getSession();
  if (session !== null) {
    redirect('/');
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600">Integration ops console</p>
        <p className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-600">
          Demo: <code>ops@healthpro.demo</code> / <code>demo-password</code>
          {' · '}
          run <code>npm run seed:run</code> first
        </p>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
