'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Recarrega os dados da página a cada `everyMs` enquanto `active` (ex.: há publicações em andamento). */
export function AutoRefresh({ active, everyMs = 8000 }: { active: boolean; everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(id);
  }, [active, everyMs, router]);
  return null;
}
