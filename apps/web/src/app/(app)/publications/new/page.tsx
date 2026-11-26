import { prisma } from '@social-manager/db';
import { FORMAT_LABEL } from '@/lib/labels';
import { listGroups } from '@/server/directory';
import { isOwnBlobUrl } from '@/server/blobUrl';
import { captionWithHashtags } from '@/server/studio/prompts';
import { maxVideoBytes, getAccountActivity } from '@/server/publishing/service';
import { minGapMinutes } from '@/server/publishing/schedule';
import { DEFAULT_TIMEZONE } from '@/server/publishing/time';
import { getWorkspace } from '@/server/workspace';
import { PublishForm, type FormAccount, type FormGroup } from './PublishForm';

export const dynamic = 'force-dynamic';
// A publicação "agora" continua rodando depois da resposta, até este limite.
export const maxDuration = 300;

const SUPPORTED = ['YOUTUBE', 'FACEBOOK', 'INSTAGRAM', 'TIKTOK'];

export default async function NewPublicationPage({ searchParams }: { searchParams: Promise<{ kind?: string; accounts?: string; project?: string }> }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [accounts, groups, activity] = await Promise.all([
    prisma.socialAccount.findMany({ where: { workspaceId: ws.id }, orderBy: [{ platform: 'asc' }, { displayName: 'asc' }] }),
    listGroups(ws.id),
    getAccountActivity(ws.id),
  ]);

  // Vindo do Estúdio: o vídeo já está enviado e os textos prontos
  const project = q.project
    ? await prisma.videoProject.findFirst({ where: { id: q.project, workspaceId: ws.id, status: 'READY' } })
    : null;
  const projectMedia = project?.finalMediaId ? await prisma.mediaAsset.findFirst({ where: { id: project.finalMediaId, workspaceId: ws.id } }) : null;
  const fromStudio = project && projectMedia?.url
    ? {
        media: { id: projectMedia.id, name: projectMedia.name, sizeMb: Math.round((Number(projectMedia.sizeBytes) / 1024 / 1024) * 10) / 10, format: projectMedia.format, width: projectMedia.width ?? 0, height: projectMedia.height ?? 0, duration: projectMedia.durationSec ?? 0 },
        title: project.selectedTitle ?? '',
        body: captionWithHashtags(project.description ?? '', project.hashtags),
        tags: project.tags,
        thumbnailUrl: project.thumbUrl && isOwnBlobUrl(project.thumbUrl) ? project.thumbUrl : null,
        thumbnailPreview: project.thumbUrl,
        groupId: project.groupId,
      }
    : null;

  const formAccounts: FormAccount[] = accounts.map((a) => {
    const act = activity.get(a.id);
    let reason: string | undefined;
    if (!a.isActive) reason = 'conta inativa';
    else if (!SUPPORTED.includes(a.platform)) reason = 'publicação ainda não disponível';
    else if (a.connectionStatus !== 'CONNECTED') reason = a.connectionStatus === 'EXPIRED' ? 'acesso expirado: reconecte' : 'não conectada';
    return {
      id: a.id, platform: a.platform, name: a.displayName, usable: !reason, reason,
      last: {
        POST: { published: act?.POST.lastPublishedAt?.toISOString() ?? null, scheduled: act?.POST.lastScheduledAt?.toISOString() ?? null },
        STORY: { published: act?.STORY.lastPublishedAt?.toISOString() ?? null, scheduled: act?.STORY.lastScheduledAt?.toISOString() ?? null },
      },
    };
  });
  const formGroups: FormGroup[] = groups.filter((g) => g.isActive).map((g) => ({
    id: g.id, name: g.name, format: g.defaultFormat, formatLabel: FORMAT_LABEL[g.defaultFormat], accountIds: g.memberships.map((m) => m.socialAccountId),
  }));

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Nova publicação</h1>
          <p>Envie o vídeo uma vez (ou use um vídeo pronto do Estúdio) e publique em todas as contas do grupo, agora ou em data e hora marcadas. Você pode desmarcar contas antes de enviar.</p>
        </div>
      </div>
      <PublishForm
        accounts={formAccounts}
        groups={formGroups}
        blobReady={!!process.env.BLOB_READ_WRITE_TOKEN}
        maxMb={Math.round(maxVideoBytes() / 1024 / 1024)}
        gapMinutes={minGapMinutes()}
        defaultTz={DEFAULT_TIMEZONE}
        initialKind={q.kind === 'STORY' ? 'STORY' : 'POST'}
        initialAccountIds={(q.accounts ?? '').split(',').filter((id) => formAccounts.some((a) => a.id === id && a.usable))}
        fromStudio={fromStudio}
        notice={q.project && !fromStudio ? 'Este vídeo do Estúdio não está pronto para publicar (confira se terminou e se o Vercel Blob está conectado).' : undefined}
      />
    </>
  );
}
