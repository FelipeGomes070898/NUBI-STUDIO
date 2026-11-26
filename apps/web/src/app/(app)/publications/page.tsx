import Link from 'next/link';
import { AutoRefresh } from '@/components/AutoRefresh';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Flash, type Search } from '@/components/Flash';
import { LocalTime } from '@/components/LocalTime';
import { PLATFORM_ICON, PLATFORM_LABEL, FORMAT_LABEL } from '@/lib/labels';
import { listPublications } from '@/server/publishing/service';
import { getWorkspace } from '@/server/workspace';
import { cancelAction, retryAction } from './actions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // "tentar de novo" roda a publicação depois da resposta

const TONE = { PUBLISHED: 'ok', FAILED: 'err', PUBLISHING: 'warn', SCHEDULED: 'warn', QUEUED: 'warn', CANCELLED: 'off', DRAFT: 'off', RETRY_SCHEDULED: 'warn', READY_FOR_APPROVAL: 'off', APPROVED: 'off' } as const;
const LABEL: Record<string, string> = { PUBLISHED: 'publicado', FAILED: 'falhou', PUBLISHING: 'publicando…', SCHEDULED: 'agendado', QUEUED: 'na fila', CANCELLED: 'cancelado', DRAFT: 'rascunho', RETRY_SCHEDULED: 'nova tentativa', READY_FOR_APPROVAL: 'aguardando', APPROVED: 'aprovado' };

export default async function PublicationsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const pubs = await listPublications(ws.id);
  const live = pubs.some((p) => p.targets.some((t) => t.status === 'PUBLISHING' || (t.status === 'SCHEDULED' && t.scheduledAt && t.scheduledAt.getTime() <= Date.now() + 60_000)));

  return (
    <>
      <AutoRefresh active={live} />
      <div className="pageHead">
        <div>
          <h1>Publicações</h1>
          <p>Vídeos enviados para os grupos e contas, agora ou agendados. Cada rede tem o seu andamento; uma falha não impede as outras.</p>
        </div>
        <Link className="btn" href="/publications/new">＋ Nova publicação</Link>
      </div>
      <Flash ok={q.ok} error={q.error} />

      {pubs.length === 0 ? (
        <div className="card empty">Nenhuma publicação ainda. <Link href="/publications/new">Envie o primeiro vídeo</Link>.</div>
      ) : (
        pubs.map((p) => (
          <div className="card" key={p.id} style={{ marginBottom: 14 }}>
            <div className="row" style={{ alignItems: 'center' }}>
              <div>
                <h3>{p.title || p.media?.name || 'Sem título'} <span className={`badge ${TONE[p.status]}`}>{LABEL[p.status]}</span> {p.kind === 'STORY' && <span className="badge">story</span>}</h3>
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
                  {p.media?.name} · {p.media ? FORMAT_LABEL[p.media.format] : ''} · {p.visibility === 'PRIVATE' ? 'privado' : 'público'} · para sair em <LocalTime iso={p.scheduledAt?.toISOString()} />
                </div>
              </div>
            </div>
            <table style={{ marginTop: 10 }}>
              <thead><tr><th>Conta</th><th>Status</th><th>Horário</th><th></th></tr></thead>
              <tbody>
                {p.targets.map((t) => (
                  <tr key={t.id}>
                    <td><span className="badge">{PLATFORM_ICON[t.account.platform]} {PLATFORM_LABEL[t.account.platform]}</span> {t.account.displayName}</td>
                    <td>
                      <span className={`badge ${TONE[t.status]}`}>{LABEL[t.status]}</span>
                      {t.externalUrl && <> <a href={t.externalUrl} target="_blank" rel="noreferrer noopener">abrir ↗</a></>}
                      {t.lastError && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--err)' }}>{t.lastError}</div>}
                      {t.note && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--warn)' }}>{t.note}</div>}
                    </td>
                    <td className="dim"><LocalTime iso={(t.publishedAt ?? t.scheduledAt)?.toISOString()} /></td>
                    <td className="num">
                      {t.status === 'FAILED' && (
                        <form action={retryAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="entityId" value={t.id} />
                          <ConfirmButton className="secondary small" message="Tentar de novo? Se a rede chegou a publicar antes do erro (ex.: tempo esgotado), o vídeo pode sair duplicado. Confira lá primeiro.">Tentar de novo</ConfirmButton>
                        </form>
                      )}
                      {t.status === 'SCHEDULED' && (
                        <form action={cancelAction} style={{ display: 'inline' }}>
                          <input type="hidden" name="entityId" value={t.id} />
                          <button className="danger small">Cancelar</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
