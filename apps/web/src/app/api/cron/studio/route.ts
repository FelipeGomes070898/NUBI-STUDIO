import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { advanceAll } from '@/server/studio/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const sha = (s: string) => createHash('sha256').update(s).digest();

/** Avança os vídeos do Estúdio em andamento (roteiro, cenas, montagem). Mesmo segredo do agendador de publicações. */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: 'CRON_SECRET não configurado.' }, { status: 503 });
  if (!timingSafeEqual(sha(req.headers.get('authorization') ?? ''), sha(`Bearer ${secret}`))) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });
  return NextResponse.json(await advanceAll({ deadlineMs: 230_000 }));
}

export { handle as GET, handle as POST };
