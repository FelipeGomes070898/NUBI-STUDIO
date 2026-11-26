import { prisma } from '@social-manager/db';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { mediaStore } from '@/server/storage';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

/** Só para desenvolvimento sem Vercel Blob: serve o vídeo final guardado em disco, apenas para sessão válida. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;
  const ws = await getWorkspace();
  const p = await prisma.videoProject.findFirst({ where: { id, workspaceId: ws.id }, select: { finalMediaId: true } });
  const media = p?.finalMediaId ? await prisma.mediaAsset.findUnique({ where: { id: p.finalMediaId }, select: { storageKey: true, url: true } }) : null;
  if (!media || media.url) return NextResponse.json({ error: 'Não encontrado' }, { status: 404 });
  const data = await mediaStore.get(media.storageKey);
  if (!data) return NextResponse.json({ error: 'Arquivo ausente' }, { status: 404 });
  return new NextResponse(Buffer.from(data), { headers: { 'Content-Type': 'video/mp4', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' } });
}
