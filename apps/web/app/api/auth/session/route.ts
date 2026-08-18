import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';
import { getAdminAuth } from '@/lib/firebase-admin';

export async function POST(request: Request) {
  const body = (await request.json()) as { idToken?: string };
  if (body.idToken === undefined || body.idToken === '') {
    return NextResponse.json({ error: 'missing_token' }, { status: 400 });
  }

  try {
    await getAdminAuth().verifyIdToken(body.idToken);
  } catch {
    return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, body.idToken, {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
