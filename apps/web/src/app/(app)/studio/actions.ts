'use server';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { run } from '@/lib/action';
import { requireSession } from '@/lib/auth';
import { optStr, str } from '@/lib/form';
import { userMessage } from '@/server/errors';
import { advanceProject, cancelProject, createVideoProject, regenerateThumbnail, resumeProject, updateProjectCopy } from '@/server/studio/pipeline';
import { getWorkspace } from '@/server/workspace';

export type StudioState = { error?: string };

export async function createProjectAction(_prev: StudioState, fd: FormData): Promise<StudioState> {
  await requireSession();
  let id: string;
  try {
    const ws = await getWorkspace();
    const sel = str(fd, 'characterId'); // '' = personagem do grupo; 'none' = sem personagem; id = este
    const aspect = str(fd, 'aspect');
    const r = await createVideoProject({
      workspaceId: ws.id,
      prompt: str(fd, 'prompt'),
      targetSeconds: Number(str(fd, 'seconds')),
      groupId: optStr(fd, 'groupId') ?? null,
      characterId: sel === '' ? undefined : sel === 'none' ? null : sel,
      aspect: aspect === '9:16' || aspect === '16:9' ? aspect : undefined,
    });
    id = r.id;
  } catch (e) {
    return { error: userMessage(e) };
  }
  // começa já (roteiro e envio das cenas), depois da resposta; o resto é conduzido pela tela e pelo agendador
  after(() => advanceProject(id, { deadlineMs: 200_000 }).catch((e) => console.error('[studio-start]', e)));
  redirect(`/studio/${id}`);
}

/** Chamado pela tela enquanto o vídeo está em andamento: avança um pouco e devolve. */
export async function advanceAction(projectId: string): Promise<string> {
  await requireSession();
  const ws = await getWorkspace();
  const { prisma } = await import('@social-manager/db');
  if (!(await prisma.videoProject.count({ where: { id: projectId, workspaceId: ws.id } }))) return 'NOT_FOUND';
  return (await advanceProject(projectId, { deadlineMs: 20_000 })).status;
}

export async function resumeAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/studio/${id}`, async (ws) => {
    await resumeProject(ws, id);
    after(() => advanceProject(id, { deadlineMs: 200_000 }).catch((e) => console.error('[studio-resume]', e)));
    return 'Retomando o que falhou.';
  });
}

export async function cancelAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/studio/${id}`, async (ws) => {
    await cancelProject(ws, id);
    return 'Projeto cancelado. Cenas já enviadas ao Google continuam e são cobradas por ele.';
  });
}

export async function updateCopyAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/studio/${id}`, async (ws) => {
    await updateProjectCopy(ws, id, { selectedTitle: str(fd, 'selectedTitle'), description: str(fd, 'description'), tags: str(fd, 'tags'), hashtags: str(fd, 'hashtags') });
    return 'Textos salvos.';
  });
}

export async function regenerateThumbAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/studio/${id}`, async (ws) => {
    await regenerateThumbnail(ws, id);
    return 'Nova thumbnail gerada.';
  });
}
