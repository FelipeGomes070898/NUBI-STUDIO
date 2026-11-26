'use client';
import { useEffect, useState } from 'react';

/** Mostra o instante no fuso do navegador (o servidor só conhece UTC). Antes de montar, mostra UTC para não divergir na hidratação. */
export function LocalTime({ iso, withSeconds = false }: { iso: string | null | undefined; withSeconds?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const d = new Date(iso);
    setText(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: withSeconds ? 'medium' : 'short' }).format(d));
  }, [iso, withSeconds]);
  if (!iso) return <>—</>;
  return <time dateTime={iso} suppressHydrationWarning>{text ?? iso.replace('T', ' ').slice(0, 16) + ' UTC'}</time>;
}
