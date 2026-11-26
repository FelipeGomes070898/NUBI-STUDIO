import Link from 'next/link';
import { Flash, type Search } from '@/components/Flash';
import { PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/labels';
import { getWeeklyProgress } from '@/server/publishing/goals';
import { DEFAULT_TIMEZONE, formatInZone } from '@/server/publishing/time';
import { getWorkspace } from '@/server/workspace';
import { setGoalAction } from './actions';

export const dynamic = 'force-dynamic';

const TONE = { DONE: 'ok', SCHEDULED: 'warn', PENDING: 'err', OFF: 'off' } as const;
const LABEL = { DONE: 'cumprida', SCHEDULED: 'agendada', PENDING: 'falta', OFF: 'desligada' } as const;

export default async function GoalsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const tz = DEFAULT_TIMEZONE;
  const { start, end, rows, summary } = await getWeeklyProgress(ws.id, new Date(), tz);
  const lastDay = new Date(end.getTime() - 60_000);

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Metas da semana</h1>
          <p>Quantos posts e stories cada conta já publicou nesta semana (domingo a domingo, como o Plano do Facebook), e o que falta. A contagem é do próprio sistema; o Plano da Meta é contado pela Meta e pode demorar para refletir.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="grid g4">
        <div className="stat"><small>Semana</small><strong style={{ fontSize: 15 }}>{formatInZone(start, tz).split(',')[0]} → {formatInZone(lastDay, tz).split(',')[0]}</strong><span>fuso {tz}</span></div>
        <div className="stat"><small>Cumpridas</small><strong>{summary.done}/{summary.total}</strong></div>
        <div className="stat"><small>Agendadas (cobrem a meta)</small><strong>{summary.scheduled}</strong></div>
        <div className="stat"><small>Faltam</small><strong>{summary.pending}</strong></div>
      </div>

      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        {rows.length === 0 ? <div className="empty">Nenhuma conta ativa. Conecte contas em <Link href="/accounts">Contas sociais</Link>.</div> : (
          <table>
            <thead><tr><th>Conta</th><th>Tipo</th><th>Progresso</th><th>Status</th><th>Meta/semana</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.accountId}:${r.kind}`}>
                  <td><span className="badge">{PLATFORM_ICON[r.platform]} {PLATFORM_LABEL[r.platform]}</span> {r.accountName}{!r.connected && <> <span className="badge warn">não conectada</span></>}</td>
                  <td>{r.kind === 'STORY' ? 'Story' : r.platform === 'INSTAGRAM' ? 'Post (Reels)' : 'Post'}</td>
                  <td style={{ minWidth: 150 }}>
                    {r.done}/{r.target}{r.scheduled > 0 && <span className="dim"> · +{r.scheduled} agendado(s)</span>}
                    {r.target > 0 && <div className="bar"><i style={{ width: `${Math.min(100, (r.done / r.target) * 100)}%` }} /></div>}
                  </td>
                  <td><span className={`badge ${TONE[r.status]}`}>{LABEL[r.status]}</span></td>
                  <td>
                    <form action={setGoalAction} className="row" style={{ flexWrap: 'nowrap' }}>
                      <input type="hidden" name="accountId" value={r.accountId} /><input type="hidden" name="kind" value={r.kind} />
                      <input name="target" type="number" min={0} max={50} defaultValue={r.target} style={{ maxWidth: 70 }} aria-label={`Meta de ${r.accountName}`} />
                      <button className="secondary small">Salvar</button>
                    </form>
                  </td>
                  <td className="num">{(r.status === 'PENDING') && r.connected && <Link className="btn small" href={`/publications/new?kind=${r.kind}&accounts=${r.accountId}`}>Criar agora</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="section"><div><h2>O que o sistema não cumpre sozinho</h2></div></div>
      <div className="card stack">
        <p style={{ margin: 0 }}><strong style={{ color: 'var(--text)' }}>Publicar um anúncio:</strong> gasta dinheiro de verdade, então fica manual (e as regras de gasto dos anúncios são da Meta).</p>
        <p style={{ margin: 0 }}><strong style={{ color: 'var(--text)' }}>Taxa de resposta:</strong> é responder mensagens e comentários. Responder de forma automática só para bater a meta é o tipo de automação que as plataformas penalizam; responda você mesmo no app.</p>
        <p style={{ margin: 0 }}><strong style={{ color: 'var(--text)' }}>Acessar insights:</strong> a Meta conta quando você abre os insights dentro do app dela; consultar por API não garante que conte.</p>
      </div>
    </>
  );
}
