import { prisma } from '@social-manager/db';
import { Flash, type Search } from '@/components/Flash';
import { fmtDate } from '@/lib/labels';
import { ADAPTER_SUPPORT } from '@/server/ai/adapters';
import { parsePricing } from '@/server/ai/pricing';
import { TASK_LABEL, TASK_MODALITY } from '@/server/ai/types';
import { getWorkspace } from '@/server/workspace';
import {
  activateModelAction, createProviderAction, deleteProviderAction, primaryProviderAction, rotateKeyAction, saveModelAction, savePreferenceAction, syncModelsAction, testProviderAction, toggleProviderAction,
} from './actions';

export const dynamic = 'force-dynamic';

const TASKS = Object.keys(TASK_LABEL) as Array<keyof typeof TASK_LABEL>;
const MODALITIES = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO'] as const;
const MOD_LABEL = { TEXT: 'Texto', IMAGE: 'Imagem', VIDEO: 'Vídeo', AUDIO: 'Áudio' };
const PRICE_FIELDS: Array<[string, string]> = [
  ['inputPerMTok', 'Entrada $/1M tokens'], ['outputPerMTok', 'Saída $/1M tokens'], ['perImage', '$ por imagem'],
  ['perSecond', '$ por segundo'], ['perMChar', '$/1M caracteres'], ['perRequest', '$ fixo por chamada'],
];

export default async function AIPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const search = (q.q ?? '').trim();
  const ws = await getWorkspace();
  const [providers, prefs, active, catalog] = await Promise.all([
    prisma.aIProvider.findMany({ where: { workspaceId: ws.id }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { models: true } } } }),
    prisma.aITaskPreference.findMany({ where: { workspaceId: ws.id } }),
    prisma.aIModel.findMany({ where: { provider: { workspaceId: ws.id }, isActive: true }, orderBy: [{ provider: { name: 'asc' } }, { displayName: 'asc' }], include: { provider: { select: { name: true } } } }),
    prisma.aIModel.findMany({
      where: { provider: { workspaceId: ws.id }, isActive: false, ...(search ? { OR: [{ providerModelId: { contains: search, mode: 'insensitive' } }, { displayName: { contains: search, mode: 'insensitive' } }] } : {}) },
      orderBy: { displayName: 'asc' }, take: 40, include: { provider: { select: { name: true } } },
    }),
  ]);
  const prefByTask = new Map(prefs.map((p) => [p.task, p]));

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Central de IA</h1>
          <p>Conecte um gateway unificado (uma chave para vários modelos) e escolha, por tarefa, entre seleção automática ou modelo fixo. As chaves são criptografadas no servidor e nunca voltam ao navegador. Consumo e preços seguem o contrato com cada provedor.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="section"><div><h2>1. Provedores</h2><p>Gateway unificado como principal; provedores individuais podem ser adicionados também.</p></div></div>
      {providers.map((p) => {
        const sup = MODALITIES.filter((m) => ADAPTER_SUPPORT[p.adapter][m]).map((m) => MOD_LABEL[m]).join(', ');
        return (
          <div className="card" key={p.id}>
            <div className="row" style={{ alignItems: 'center' }}>
              <div>
                <h3>{p.name} {p.isPrimary && <span className="badge ok">principal</span>} <span className="badge">{p.kind === 'UNIFIED' ? 'gateway unificado' : 'individual'}</span> {!p.isActive && <span className="badge off">desativado</span>}</h3>
                <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{p.baseUrl} · chave {p.secretHint} · {p._count.models} modelos no catálogo · executa: {sup}</div>
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  {p.lastTestedAt ? (
                    <span className={`badge ${p.lastTestOk ? 'ok' : 'err'}`}>{p.lastTestOk ? 'conexão OK' : 'falhou'} · {fmtDate(p.lastTestedAt)}</span>
                  ) : <span className="badge warn">ainda não testado</span>}
                  {p.lastTestError && <span className="dim"> {p.lastTestError}</span>}
                  {p.lastSyncedAt && <span className="dim"> · catálogo sincronizado em {fmtDate(p.lastSyncedAt)}</span>}
                </div>
              </div>
              <div className="noflex" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[['Testar conexão', testProviderAction], ['Sincronizar modelos', syncModelsAction]].map(([label, action]) => (
                  <form key={String(label)} action={action as (fd: FormData) => Promise<void>}><input type="hidden" name="entityId" value={p.id} /><button className="small">{String(label)}</button></form>
                ))}
                {!p.isPrimary && p.isActive && <form action={primaryProviderAction}><input type="hidden" name="entityId" value={p.id} /><button className="secondary small">Tornar principal</button></form>}
                <form action={toggleProviderAction}><input type="hidden" name="entityId" value={p.id} /><input type="hidden" name="active" value={String(!p.isActive)} /><button className="secondary small">{p.isActive ? 'Desativar' : 'Ativar'}</button></form>
              </div>
            </div>
            <details>
              <summary>Trocar chave / excluir</summary>
              <form action={rotateKeyAction} className="row">
                <input type="hidden" name="entityId" value={p.id} />
                <label>Nova chave de API<input type="password" name="apiKey" autoComplete="off" required minLength={8} /></label>
                <button className="secondary small">Substituir chave</button>
              </form>
              <form action={deleteProviderAction} style={{ marginTop: 10 }}><input type="hidden" name="entityId" value={p.id} /><button className="danger small">Excluir provedor</button> <small>Só é possível se não houver histórico de gerações.</small></form>
            </details>
          </div>
        );
      })}

      <form action={createProviderAction} className="card" style={{ marginTop: 14 }}>
        <h3>Adicionar provedor</h3>
        <p style={{ margin: '4px 0 0', fontSize: 12 }}>Para <strong>vídeo (Veo)</strong> cadastre também um provedor do tipo <em>Google Gemini</em> com a chave do Google AI Studio. Para o resto, qualquer API no formato OpenAI (<code>/models</code>, <code>/chat/completions</code>, <code>/images/generations</code>, <code>/audio/speech</code>): gateways unificados, OpenRouter, OpenAI etc. Use a URL base exatamente como a documentação do provedor indica (geralmente termina em <code>/v1</code>).</p>
        <div className="row" style={{ marginTop: 12 }}>
          <label>Nome<input name="name" required maxLength={60} placeholder="ex.: Meu gateway" /></label>
          <label>Tipo<select name="kind" defaultValue="UNIFIED"><option value="UNIFIED">Gateway unificado</option><option value="DIRECT">Provedor individual</option></select></label>
          <label>Protocolo
            <select name="adapter" defaultValue="OPENAI_COMPATIBLE">
              <option value="OPENAI_COMPATIBLE">Padrão OpenAI (gateway, OpenAI, OpenRouter…): texto, imagem, áudio</option>
              <option value="GOOGLE_GEMINI">Google Gemini / Veo: texto e VÍDEO</option>
            </select>
          </label>
          <label>URL base (no Google, pode deixar vazio)<input name="baseUrl" type="url" placeholder="https://api.exemplo.com/v1" /></label>
          <label>Chave de API<input name="apiKey" type="password" autoComplete="off" required minLength={8} /></label>
          <button>Cadastrar</button>
        </div>
      </form>

      <div className="section"><div><h2>2. Modelo por tarefa</h2><p><strong>Automático</strong>: usa os modelos que você aprovou para a tarefa e, sem eles, escolhe pelo provedor principal e menor custo estimado. <strong>Manual</strong>: sempre o modelo fixo. Alternativas só entram se você aprová-las aqui.</p></div></div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Tarefa</th><th>Modo</th><th>Modelo</th><th>Alternativas aprovadas</th><th></th></tr></thead>
          <tbody>
            {TASKS.map((t) => {
              const pref = prefByTask.get(t);
              const eligible = active.filter((m) => m.modalities.includes(TASK_MODALITY[t]));
              const formId = `pref-${t}`;
              return (
                <tr key={t}>
                  <td><strong>{TASK_LABEL[t]}</strong><div className="dim">{MOD_LABEL[TASK_MODALITY[t]]}</div></td>
                  <td><select form={formId} name="mode" defaultValue={pref?.mode ?? 'AUTO'}><option value="AUTO">Automático</option><option value="MANUAL">Manual</option></select></td>
                  <td><select form={formId} name="modelId" defaultValue={pref?.modelId ?? ''}><option value="">— automático —</option>{eligible.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></td>
                  <td><select form={formId} name="fallbackModelIds" multiple size={Math.min(4, Math.max(2, eligible.length))} defaultValue={pref?.fallbackModelIds ?? []}>{eligible.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</select></td>
                  <td className="num"><form id={formId} action={savePreferenceAction}><input type="hidden" name="task" value={t} /><button className="small">Salvar</button></form></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <VideoNote />

      <div className="section"><div><h2>3. Modelos ativos ({active.length})</h2><p>Só modelos ativos entram no roteamento. Confirme as modalidades (a detecção é uma sugestão) e informe o preço: sem preço, o custo não é controlável e o modelo é bloqueado.</p></div></div>
      {active.length === 0 ? (
        <div className="card empty">Nenhum modelo ativo. Sincronize o catálogo de um provedor e ative os modelos abaixo.</div>
      ) : (
        active.map((m) => {
          const price = (parsePricing(m.pricing) ?? {}) as Record<string, number>;
          return (
            <div className="card" key={m.id} style={{ padding: 14 }}>
              <details>
                <summary>
                  <strong style={{ color: 'var(--text)' }}>{m.displayName}</strong> <span className="dim">{m.provider.name} · {m.providerModelId}</span>{' '}
                  {m.modalities.map((x) => <span className="badge" key={x}>{MOD_LABEL[x]}</span>)}
                  {m.pricing ? <span className="badge ok">preço {m.pricingSource === 'MANUAL' ? 'manual' : 'do catálogo'}</span> : <span className="badge warn">sem preço</span>}
                </summary>
                <form action={saveModelAction} className="stack">
                  <input type="hidden" name="entityId" value={m.id} />
                  <div className="checks">
                    {MODALITIES.map((x) => <label className="inline" key={x}><input type="checkbox" name="modalities" value={x} defaultChecked={m.modalities.includes(x)} /> {MOD_LABEL[x]}</label>)}
                  </div>
                  <div className="row">
                    {PRICE_FIELDS.map(([k, label]) => <label key={k}>{label}<input name={k} inputMode="decimal" defaultValue={price[k] ?? ''} /></label>)}
                  </div>
                  <div className="row"><label className="inline noflex"><input type="checkbox" name="isActive" defaultChecked /> Ativo</label><button className="small">Salvar modelo</button></div>
                </form>
              </details>
            </div>
          );
        })
      )}

      <div className="section"><div><h2>4. Catálogo (modelos inativos)</h2><p>Mostrando até 40. Busque pelo nome ou id.</p></div>
        <form method="get" className="row noflex" style={{ flexWrap: 'nowrap' }}><input name="q" defaultValue={search} placeholder="buscar modelo…" aria-label="Buscar modelo" /><button className="secondary small">Buscar</button></form>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {catalog.length === 0 ? <div className="empty">Nada por aqui. {providers.length ? 'Sincronize os modelos de um provedor.' : 'Cadastre um provedor primeiro.'}</div> : (
          <table><tbody>
            {catalog.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.displayName}</strong><div className="dim">{m.provider.name} · {m.providerModelId}</div></td>
                <td>{m.modalities.map((x) => <span className="badge" key={x}>{MOD_LABEL[x]}</span>)}{m.pricing ? <span className="badge ok">com preço</span> : <span className="badge warn">sem preço</span>}</td>
                <td className="num"><form action={activateModelAction}><input type="hidden" name="entityId" value={m.id} /><input type="hidden" name="q" value={search} /><button className="secondary small">Ativar</button></form></td>
              </tr>
            ))}
          </tbody></table>
        )}
      </div>
    </>
  );
}

function VideoNote() {
  return <p className="footnote" style={{ marginTop: 8 }}>Vídeo: o protocolo OpenAI-compatível não cobre vídeo (cada gateway tem seu fluxo). Para gerar vídeo cadastre um provedor do tipo <strong>Google Gemini / Veo</strong> (chave do Google AI Studio), sincronize os modelos, ative o Veo e informe o <strong>preço por segundo</strong>. O Estúdio de vídeos usa os modelos escolhidos aqui: <em>Criar roteiro</em> e <em>Legendas e descrições</em> (texto, ex.: Claude), <em>Gerar imagens</em> (thumbnail, ex.: ChatGPT) e <em>Gerar vídeos</em> (Veo).</p>;
}
