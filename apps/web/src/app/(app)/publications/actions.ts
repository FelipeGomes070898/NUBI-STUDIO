'use server';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { run } from '@/lib/action';
import { requireSession } from '@/lib/auth';
import { bool, str } from '@/lib/form';
import { UserError, userMessage } from '@/server/errors';
import { cancelTarget, createPublication, processDue, registerMedia, retryTarget } from '@/server/publishing/service';
import { DEFAULT_TIMEZONE, isValidTimeZone, zonedToUtc } from '@/server/publishing/time';
import { getWorkspace } from '@/server/workspace';

export type PublishState = { error?: string };

/** Chamado pelo navegador depois que o vídeo foi enviado ao armazenamento. */
export async function registerMediaAction(p: {
  url: string; name: string; sizeBytes: number; mimeType: string; width?: number | null; height?: number | null; durationSec?: number | null;
}): Promise<{ id?: string; format?: string; error?: string }> {
  await requireSession();
  try {
    const ws = await getWorkspace();
    const m = await registerMedia({ workspaceId: ws.id, ...p });
    return { id: m.id, format: m.format };
  } catch (e) {
    return { error: userMessage(e) };
  }
}

/** Devolve o erro para o formulário (que mantém tudo preenchido); em caso de sucesso, redireciona. */
export async function publishAction(_prev: PublishState, fd: FormData): Promise<PublishState> {
  await requireSession();
  let publicationIds: string[] = [];
  let runNow = false;
  try {
    const ws = await getWorkspace();
    const tz = isValidTimeZone(str(fd, 'timezone')) ? str(fd, 'timezone') : DEFAULT_TIMEZONE;
    const mode = str(fd, 'mode') === 'SCHEDULE' ? 'SCHEDULE' : 'NOW';
    let when: Parameters<typeof createPublication>[0]['when'] = { mode: 'NOW' };
    if (mode === 'SCHEDULE') {
      const local = str(fd, 'when');
      if (!local) throw new UserError('Escolha a data e a hora do agendamento.');
      try {
        when = { mode: 'SCHEDULE', scheduledAt: zonedToUtc(local, tz) };
      } catch {
        throw new UserError('Data e hora inválidas.');
      }
    }
    const r = await createPublication({
      workspaceId: ws.id,
      mediaAssetId: str(fd, 'mediaId'),
      title: str(fd, 'title'),
      body: str(fd, 'body'),
      visibility: str(fd, 'visibility') === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
      kind: str(fd, 'kind') === 'STORY' ? 'STORY' : 'POST',
      alsoStory: bool(fd, 'alsoStory'),
      groupIds: fd.getAll('groupIds').map(String),
      accountIds: fd.getAll('accountIds').map(String),
      when,
      timezone: tz,
      ignoreGap: bool(fd, 'ignoreGap'),
    });
    publicationIds = r.publicationIds;
    runNow = r.runNow;
  } catch (e) {
    return { error: userMessage(e) };
  }
  // "Publicar agora": roda depois da resposta (a função continua viva até o limite de duração)
  if (runNow) after(async () => { for (const publicationId of publicationIds) await processDue({ publicationId }).catch((e) => console.error('[publish-now]', e)); });
  redirect(`/publications?ok=${encodeURIComponent(runNow ? 'Publicando agora. Acompanhe o andamento abaixo.' : publicationIds.length > 1 ? 'Post e story agendados.' : 'Publicação agendada.')}`);
}

export async function retryAction(fd: FormData) {
  await run('/publications', async (ws) => {
    const publicationId = await retryTarget(ws, str(fd, 'entityId'));
    after(() => processDue({ publicationId }).catch((e) => console.error('[publish-retry]', e)));
    return 'Reenviado para a fila. Publicando agora.';
  });
}

export async function cancelAction(fd: FormData) {
  await run('/publications', async (ws) => {
    await cancelTarget(ws, str(fd, 'entityId'));
    return 'Agendamento cancelado.';
  });
}
