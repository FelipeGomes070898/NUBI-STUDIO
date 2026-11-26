import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { maxVideoBytes } from '@/server/publishing/service';
import { VIDEO_MIME_TYPES } from '@/server/publishing/types';

export const dynamic = 'force-dynamic';

/**
 * Emite o token para o NAVEGADOR enviar o vídeo direto ao armazenamento (o corpo do vídeo não passa pela
 * função: a Vercel limita requisições a 4,5 MB). Só quem tem sessão recebe token; só vídeo; com teto de tamanho.
 */
export async function POST(req: Request) {
  await requireSession();
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json({ error: 'Armazenamento de vídeo não configurado (BLOB_READ_WRITE_TOKEN).' }, { status: 503 });
  }
  const body = (await req.json().catch(() => null)) as HandleUploadBody | null;
  if (!body) return NextResponse.json({ error: 'Requisição inválida.' }, { status: 400 });
  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: VIDEO_MIME_TYPES,
        maximumSizeInBytes: maxVideoBytes(),
        addRandomSuffix: true, // o endereço público fica impossível de adivinhar
      }),
      // O vídeo é registrado pelo formulário (registerMediaAction) com a URL devolvida ao navegador.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(json);
  } catch {
    return NextResponse.json({ error: 'Não foi possível preparar o envio.' }, { status: 400 });
  }
}
