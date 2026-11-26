import { createHash, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { processDue } from '@/server/publishing/service';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Publica o que já venceu. Chamado pelo agendador (GitHub Actions a cada ~5 min; a Vercel também chama 1×/dia).
 * Autenticação por segredo (CRON_SECRET), não por sessão; sem o segredo configurado, fica desligado.
 */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16) return NextResponse.json({ error: 'CRON_SECRET não configurado.' }, { status: 503 });
  const given = req.headers.get('authorization') ?? '';
  if (!timingSafeEqual(sha(given), sha(`Bearer ${secret}`))) return NextResponse.json({ error: 'Não autorizado.' }, { status: 401 });

  const stats = await processDue({ deadlineMs: 230_000 });
  return NextResponse.json(stats);
}

export { handle as GET, handle as POST };
