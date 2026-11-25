import { prisma } from '@social-manager/db';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { mediaStore } from '@/server/storage';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

// Só tipos que o navegador não executa. Nunca servir svg/html gerado.
const SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav']);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const ws = await getWorkspace();
  const job = await prisma.aIJob.findFirst({ where: { id, workspaceId: ws.id }, select: { outputStorageKey: true, outputMimeType: true } });
  if (!job?.outputStorageKey || !job.outputMimeType || !SAFE_TYPES.has(job.outputMimeType)) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 });
  const data = await mediaStore.get(job.outputStorageKey);
  if (!data) return NextResponse.json({ error: 'Arquivo ausente' }, { status: 404 });
  return new NextResponse(Buffer.from(data), {
    headers: { 'Content-Type': job.outputMimeType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' },
  });
}
