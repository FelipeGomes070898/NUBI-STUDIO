import { prisma } from '@social-manager/db';
import { FORMAT_LABEL } from '@/lib/labels';
import { listGroups } from '@/server/directory';
import { maxVideoBytes, getAccountActivity } from '@/server/publishing/service';
import { minGapMinutes } from '@/server/publishing/schedule';
import { DEFAULT_TIMEZONE } from '@/server/publishing/time';
import { getWorkspace } from '@/server/workspace';
import { PublishForm, type FormAccount, type FormGroup } from './PublishForm';

export const dynamic = 'force-dynamic';
// A publicação "agora" continua rodando depois da resposta, até este limite.
export const maxDuration = 300;

const SUPPORTED = ['YOUTUBE', 'FACEBOOK', 'INSTAGRAM', 'TIKTOK'];

export default async function NewPublicationPage({ searchParams }: { searchParams: Promise<{ kind?: string; accounts?: string }> }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [accounts, groups, activity] = await Promise.all([
    prisma.socialAccount.findMany({ where: { workspaceId: ws.id }, orderBy: [{ platform: 'asc' }, { displayName: 'asc' }] }),
    listGroups(ws.id),
    getAccountActivity(ws.id),
  ]);

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
          <p>Envie o vídeo uma vez e publique em todas as contas do grupo, agora ou em data e hora marcadas. Você pode desmarcar contas antes de enviar.</p>
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
      />
    </>
  );
}
