'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function ReplayDeadLetterButton({
  deadLetterId,
  therapyOrgId,
}: {
  deadLetterId: string;
  therapyOrgId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function replay() {
    setPending(true);
    setError(null);

    try {
      const response = await fetch(`/api/dead-letters/${deadLetterId}/replay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ therapyOrgId, note: 'Replayed from ops console' }),
      });

      if (!response.ok) {
        const payload = (await response.json()) as { error?: string };
        throw new Error(payload.error ?? 'replay_failed');
      }

      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'replay_failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void replay()}
        disabled={pending}
        className="rounded-md bg-teal-700 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? 'Replaying…' : 'Replay'}
      </button>
      {error !== null ? <p className="text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}
