'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { advanceAction } from '../actions';

/** Enquanto o vídeo está em andamento, faz o projeto avançar (a cada ~15 s) e atualiza a tela. O agendador faz o mesmo em segundo plano. */
export function ProgressDriver({ projectId, active }: { projectId: string; active: boolean }) {
  const router = useRouter();
  const busy = useRef(false);
  const [last, setLast] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const tick = async () => {
      if (busy.current || stop) return;
      busy.current = true;
      try { setLast(await advanceAction(projectId)); } catch { /* tenta de novo no próximo ciclo */ }
      busy.current = false;
      if (!stop) router.refresh();
    };
    void tick();
    const id = setInterval(tick, 15_000);
    return () => { stop = true; clearInterval(id); };
  }, [active, projectId, router]);

  if (!active) return null;
  return <small className="dim" aria-live="polite">⟳ acompanhando automaticamente{last ? ` (${last.toLowerCase()})` : ''}…</small>;
}
