import { prisma } from '@social-manager/db';
import { Flash, type Search } from '@/components/Flash';
import { fmtDate } from '@/lib/labels';
import { usd } from '@/server/ai/pricing';
import { TASK_LABEL, TASK_MODALITY } from '@/server/ai/types';
import { getWorkspace } from '@/server/workspace';
import { generateAction } from './actions';

export const dynamic = 'force-dynamic';
// Server actions herdam este limite: imagens/áudios podem demorar (máx. do plano Hobby com Fluid compute).
export const maxDuration = 300;

const STATUS_TONE = { SUCCEEDED: 'ok', FAILED: 'err', RUNNING: 'warn', QUEUED: 'warn', CANCELLED: 'off' } as const;
const STATUS_LABEL = { SUCCEEDED: 'concluído', FAILED: 'falhou', RUNNING: 'em execução', QUEUED: 'na fila', CANCELLED: 'cancelado' } as const;

export default async function StudioPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [models, clients, history, selected] = await Promise.all([
    prisma.aIModel.findMany({
      where: { isActive: true, provider: { workspaceId: ws.id, isActive: true } },
      orderBy: [{ displayName: 'asc' }],
      include: { provider: { select: { name: true, adapter: true } } },
    }),
    prisma.client.findMany({ where: { workspaceId: ws.id, isActive: true }, orderBy: { name: 'asc' } }),
    prisma.aIJob.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'desc' }, take: 20, include: { client: { select: { name: true } } } }),
    q.job ? prisma.aIJob.findFirst({ where: { id: q.job, workspaceId: ws.id } }) : null,
  ]);
  const tasks = Object.keys(TASK_LABEL) as Array<keyof typeof TASK_LABEL>;

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Estúdio de IA</h1>
          <p>Gere roteiros, legendas, imagens e narrações. Escolha o modelo ou deixe a Central decidir. O valor máximo é reservado na carteira antes da chamada e o custo real é debitado ao final.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <form action={generateAction} className="card stack">
        <div className="row">
          <label>Tarefa
            <select name="task" defaultValue="SCRIPT">
              {tasks.map((t) => <option key={t} value={t}>{TASK_LABEL[t]}{t === 'VIDEO' ? ' (adapter de vídeo pendente)' : ''}</option>)}
            </select>
          </label>
          <label>Modelo
            <select name="modelId" defaultValue="">
              <option value="">Automático / preferência da tarefa</option>
              {models.map((m) => <option key={m.id} value={m.id}>{m.displayName} · {m.provider.name} · {m.modalities.join('/').toLowerCase()}</option>)}
            </select>
          </label>
          <label>Cliente (consumo)
            <select name="clientId" defaultValue=""><option value="">— sem cliente —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        </div>
        <label>Pedido
          <textarea name="prompt" required maxLength={20000} placeholder="Descreva o que quer gerar…" />
        </label>
        <details>
          <summary>Opções avançadas</summary>
          <div className="row">
            <label>Instrução de sistema (texto)<input name="system" maxLength={4000} /></label>
            <label>Máx. tokens de saída (texto)<input name="maxOutputTokens" inputMode="numeric" placeholder="2048" /></label>
            <label>Tamanho (imagem)<input name="imageSize" placeholder="1024x1024" /></label>
            <label>Voz (narração)<input name="voice" placeholder="alloy" /></label>
          </div>
        </details>
        <div><button>Gerar</button> <small>A chamada é síncrona: imagens e áudios podem levar alguns segundos.</small></div>
      </form>

      {selected && (
        <div className="card result" style={{ marginTop: 14 }}>
          <h3>Resultado · {TASK_LABEL[selected.task]} <span className={`badge ${STATUS_TONE[selected.status]}`}>{STATUS_LABEL[selected.status]}</span></h3>
          <p style={{ margin: '6px 0 0', fontSize: 12 }}>{selected.providerModelId} · {selected.selectionMode === 'AUTO' ? 'seleção automática' : 'seleção manual'}{selected.actualCost ? ` · custo ${usd(selected.actualCost.toString())}` : ''}</p>
          {selected.routeReason && <p style={{ margin: '2px 0 0', fontSize: 11 }}>{selected.routeReason}</p>}
          {selected.errorMessage && <div className="flash flashErr" style={{ marginTop: 10 }}>{selected.errorMessage}</div>}
          {selected.outputText && <pre className="out">{selected.outputText}</pre>}
          {selected.modality === 'IMAGE' && (selected.outputStorageKey || selected.outputUrl) && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.outputStorageKey ? `/api/ai/jobs/${selected.id}/output` : selected.outputUrl!} alt="Imagem gerada" />
          )}
          {selected.modality === 'AUDIO' && selected.outputStorageKey && <audio controls src={`/api/ai/jobs/${selected.id}/output`} style={{ width: '100%', marginTop: 10 }} />}
        </div>
      )}

      <div className="section"><div><h2>Histórico</h2></div></div>
      <div className="card" style={{ padding: 0 }}>
        {history.length === 0 ? <div className="empty">Nenhuma geração ainda.</div> : (
          <table>
            <thead><tr><th>Quando</th><th>Tarefa</th><th>Modelo</th><th>Cliente</th><th>Status</th><th className="num">Custo</th></tr></thead>
            <tbody>
              {history.map((j) => (
                <tr key={j.id}>
                  <td><a href={`/ai/studio?job=${j.id}`}>{fmtDate(j.createdAt)}</a></td>
                  <td>{TASK_LABEL[j.task]}</td>
                  <td>{j.providerModelId}</td>
                  <td>{j.client?.name ?? <span className="dim">—</span>}</td>
                  <td><span className={`badge ${STATUS_TONE[j.status]}`}>{STATUS_LABEL[j.status]}</span></td>
                  <td className="num">{j.actualCost ? usd(j.actualCost.toString()) : j.reservedAmount.gt(0) ? <span className="dim">reservado {usd(j.reservedAmount.toString())}</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
