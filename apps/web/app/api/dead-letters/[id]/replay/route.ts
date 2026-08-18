import { NextResponse } from 'next/server';
import { getSession, requirePermission } from '@/lib/auth';
import { replayDeadLetterFromConsole } from '@/lib/replay';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session === null) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  try {
    requirePermission(session, 'deadLetter:replay');
  } catch {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id: deadLetterId } = await context.params;
  const body = (await request.json()) as { therapyOrgId?: string; note?: string };
  const therapyOrgId = body.therapyOrgId ?? session.user.therapyOrgId;
  const note = body.note ?? 'Replayed from ops console';

  if (therapyOrgId !== session.user.therapyOrgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const result = await replayDeadLetterFromConsole({
    therapyOrgId,
    deadLetterId,
    actorUid: session.user.uid,
    note,
  });

  if (result.status === 'notFound') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  return NextResponse.json(result);
}
