import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConfirmButton } from '@/components/ConfirmButton';
import { Flash, type Search } from '@/components/Flash';
import { LocalTime } from '@/components/LocalTime';
import { usd } from '@/server/ai/pricing';
import { isOwnBlobUrl } from '@/server/blobUrl';
import { getProject } from '@/server/studio/pipeline';
import { getWorkspace } from '@/server/workspace';
import { STATUS } from '../status';
import { cancelAction, regenerateThumbAction, resumeAction, updateCopyAction } from '../actions';
import { ProgressDriver } from './ProgressDriver';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // a tela avança o projeto enquanto está aberta

const SCENE = { PENDING: ['na fila', 'off'], SUBMITTED: ['gerando', 'warn'], DONE: ['pronta', 'ok'], FAILED: ['falhou', 'err'] } as const;

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const ws = await getWorkspace();
  const p = await getProject(ws.id, id);
  if (!p) notFound();
  const [label, tone] = STATUS[p.status];
  const active = ['QUEUED', 'PLANNING', 'GENERATING', 'RENDERING'].includes(p.status);
  const done = p.scenes.filter((s) => s.status === 'DONE').length;
  const publicVideo = !!p.finalUrl && isOwnBlobUrl(p.finalUrl);

  return (
    <>
      <div className="pageHead">
        <div>
          <p style={{ margin: 0 }}><Link href="/studio">← Estúdio</Link></p>
          <h1>{p.selectedTitle ?? 'Vídeo em criação'} <span className={`badge ${tone}`} style={{ verticalAlign: 'middle' }}>{label}</span></h1>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />
      <ProgressDriver projectId={p.id} active={active} />

      <div className="grid g4" style={{ marginTop: 10 }}>
        <div className="stat"><small>Andamento</small><strong style={{ fontSize: 15 }}>{p.step ?? '—'}</strong><span>{done}/{p.scenes.length} cenas prontas</span></div>
        <div className="stat"><small>Duração / formato</small><strong style={{ fontSize: 18 }}>{p.targetSeconds}s · {p.aspect}</strong><span>{p.scenes.map((s) => `${s.seconds}s`).join(' + ')}</span></div>
        <div className="stat"><small>Personagem fixo</small><strong style={{ fontSize: 15 }}>{p.character?.name ?? 'nenhum'}</strong><span>{p.group?.name ?? 'sem grupo'}</span></div>
        <div className="stat"><small>Custo</small><strong style={{ fontSize: 18 }}>{usd(p.spent)}</strong><span>máx. estimado {p.estimatedCost ? usd(p.estimatedCost.toString()) : '—'}{p.reserved.gt(0) ? ` · retido ${usd(p.reserved)}` : ''}</span></div>
      </div>

      {p.error && <div className={`flash ${p.status === 'FAILED' ? 'flashErr' : ''}`} style={{ marginTop: 14, ...(p.status === 'FAILED' ? {} : { background: '#2f2511', border: '1px solid #5a4416', color: '#f5d48a' }) }}>{p.error}</div>}

      <div className="row" style={{ marginTop: 14 }}>
        {p.status === 'READY' && <Link className="btn noflex" href={`/publications/new?project=${p.id}`}>➤ Publicar este vídeo</Link>}
        {p.status === 'FAILED' && <form action={resumeAction} className="noflex"><input type="hidden" name="entityId" value={p.id} /><button>Tentar de novo o que falhou</button></form>}
        {active && <form action={cancelAction} className="noflex"><input type="hidden" name="entityId" value={p.id} /><ConfirmButton className="danger small" message="Cancelar? Cenas já enviadas ao Google continuam e são cobradas por ele.">Cancelar</ConfirmButton></form>}
      </div>
      {p.status === 'READY' && !publicVideo && <p style={{ fontSize: 12, color: 'var(--warn)' }}>Este vídeo está guardado só em disco (sem Vercel Blob), então não dá para publicá-lo. Conecte o Blob ao projeto.</p>}

      {p.finalUrl && p.status === 'READY' && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>Vídeo final</h3>
          <video controls src={p.finalUrl} poster={p.thumbUrl ?? undefined} style={{ maxWidth: p.aspect === '9:16' ? 300 : 560, width: '100%', borderRadius: 12, marginTop: 10, background: '#000' }} />
        </div>
      )}

      <div className="grid g2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>Thumbnail</h3>
          {p.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.thumbUrl} alt="Thumbnail gerada" style={{ maxWidth: p.aspect === '9:16' ? 200 : 360, width: '100%', borderRadius: 10, marginTop: 10 }} />
          ) : p.thumbError ? <p style={{ color: 'var(--err)', fontSize: 13 }}>{p.thumbError}</p> : <p className="dim" style={{ fontSize: 13 }}>{active ? 'Será gerada junto com as cenas…' : 'Sem thumbnail.'}</p>}
          {p.titles.length > 0 && (
            <form action={regenerateThumbAction} style={{ marginTop: 10 }}>
              <input type="hidden" name="entityId" value={p.id} />
              <ConfirmButton className="secondary small" message="Gerar outra thumbnail? Isso cobra uma nova imagem.">Gerar outra thumbnail</ConfirmButton>
            </form>
          )}
        </div>

        <form action={updateCopyAction} className="card stack">
          <input type="hidden" name="entityId" value={p.id} />
          <h3>Título, descrição, tags e hashtags</h3>
          {p.titles.length === 0 ? <p className="dim" style={{ fontSize: 13 }}>Serão escritos pela IA no início do processo…</p> : (
            <>
              <label>Título (escolha uma sugestão ou edite)
                <input name="selectedTitle" list="titles" defaultValue={p.selectedTitle ?? ''} maxLength={100} required />
                <datalist id="titles">{p.titles.map((t) => <option key={t} value={t} />)}</datalist>
              </label>
              <small className="dim">Sugestões: {p.titles.join(' · ')}</small>
              <label>Descrição<textarea name="description" defaultValue={p.description ?? ''} maxLength={1500} style={{ minHeight: 90 }} /></label>
              <label>Tags (separadas por vírgula; usadas no YouTube)<input name="tags" defaultValue={p.tags.join(', ')} /></label>
              <label>Hashtags<input name="hashtags" defaultValue={p.hashtags.join(' ')} /></label>
              <div><button className="secondary small">Salvar textos</button></div>
            </>
          )}
        </form>
      </div>

      <div className="section"><div><h2>Cenas</h2><p>Cada cena leva a descrição do personagem fixo. O Google gera os clipes; o sistema junta tudo no final.</p></div></div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>#</th><th>Duração</th><th>Status</th><th>Prompt da cena</th></tr></thead>
          <tbody>
            {p.scenes.map((s) => {
              const [l, t] = SCENE[s.status];
              return (
                <tr key={s.id}>
                  <td>{s.index + 1}</td>
                  <td>{s.seconds}s</td>
                  <td><span className={`badge ${t}`}>{l}</span>{s.error && <div style={{ fontSize: 12, marginTop: 4, color: 'var(--err)' }}>{s.error}</div>}</td>
                  <td>{s.prompt ? <details><summary>ver prompt</summary><pre className="out">{s.prompt}</pre></details> : <span className="dim">aguardando o roteiro</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="footnote">Ideia original: {p.prompt} · criado em <LocalTime iso={p.createdAt.toISOString()} /></p>
    </>
  );
}
