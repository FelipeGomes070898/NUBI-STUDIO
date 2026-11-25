import { Flash, type Search } from '@/components/Flash';
import { fmtDate } from '@/lib/labels';
import { usd } from '@/server/ai/pricing';
import { getFinanceOverview } from '@/server/billing/wallet';
import { getWorkspace } from '@/server/workspace';
import { adjustAction, clientBudgetAction, creditAction, settingsAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function BillingPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const f = await getFinanceOverview(ws.id);
  const limit = f.wallet.monthlyLimit?.toString();
  const pct = (spent: string, cap: string) => Math.min(100, (Number(spent) / Number(cap)) * 100 || 0);

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Custos e consumo</h1>
          <p>Carteira central do workspace, com orçamento mensal por cliente. Esta carteira é um <strong>controle interno</strong>: o saldo real e a cobrança ficam no seu provedor de IA. Registre aqui os créditos que você comprou lá. Valores em USD; o mês é contado em UTC.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="grid g4">
        <div className="stat"><small>Saldo</small><strong>{usd(f.balance)}</strong><span>livre: {usd(f.balance.sub(f.reserved))}</span></div>
        <div className="stat"><small>Retido em gerações em andamento</small><strong>{usd(f.reserved)}</strong><span>liberado ao concluir</span></div>
        <div className="stat"><small>Consumo no mês</small><strong>{usd(f.monthSpent)}</strong>{limit && <><div className={`bar ${pct(f.monthSpent.toString(), limit) >= 100 ? 'over' : ''}`}><i style={{ width: `${pct(f.monthSpent.toString(), limit)}%` }} /></div><span>limite {usd(limit)}</span></>}</div>
        <div className="stat"><small>Sem cliente atribuído</small><strong>{usd(f.unassignedSpent)}</strong><span>consumo no mês</span></div>
      </div>

      <div className="grid g3" style={{ marginTop: 14 }}>
        <form action={creditAction} className="card stack">
          <h3>Registrar crédito</h3>
          <label>Valor (USD)<input name="amount" inputMode="decimal" required /></label>
          <label>Descrição<input name="description" placeholder="ex.: recarga no gateway" /></label>
          <button>Registrar</button>
        </form>
        <form action={settingsAction} className="card stack">
          <h3>Limites</h3>
          <label>Limite mensal global (USD, vazio = sem limite)<input name="monthlyLimit" inputMode="decimal" defaultValue={limit ?? ''} /></label>
          <label className="inline"><input type="checkbox" name="allowUnpricedModels" defaultChecked={f.wallet.allowUnpricedModels} /> Permitir modelos sem preço (custo não controlado)</label>
          <button>Salvar limites</button>
        </form>
        <form action={adjustAction} className="card stack">
          <h3>Ajuste manual</h3>
          <label>Valor (use − para reduzir)<input name="amount" inputMode="decimal" required placeholder="-1.50" /></label>
          <label>Motivo (obrigatório)<input name="description" required /></label>
          <button className="secondary">Aplicar ajuste</button>
        </form>
      </div>

      <div className="section"><div><h2>Orçamento por cliente</h2><p>Quando o consumo do mês somado ao valor reservado ultrapassaria o orçamento, a geração é bloqueada.</p></div></div>
      <div className="card" style={{ padding: 0 }}>
        {f.clients.length === 0 ? <div className="empty">Nenhum cliente cadastrado.</div> : (
          <table>
            <thead><tr><th>Cliente</th><th>Consumo no mês</th><th>Orçamento mensal</th></tr></thead>
            <tbody>
              {f.clients.map((c) => {
                const cap = c.monthlyBudget?.toString();
                return (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong>{!c.isActive && <> <span className="badge off">inativo</span></>}</td>
                    <td style={{ minWidth: 180 }}>{usd(c.monthSpent)}{cap && <div className={`bar ${pct(c.monthSpent.toString(), cap) >= 100 ? 'over' : ''}`}><i style={{ width: `${pct(c.monthSpent.toString(), cap)}%` }} /></div>}</td>
                    <td>
                      <form action={clientBudgetAction} className="row" style={{ flexWrap: 'nowrap' }}>
                        <input type="hidden" name="entityId" value={c.id} />
                        <input name="monthlyBudget" inputMode="decimal" defaultValue={cap ?? ''} placeholder="sem limite" style={{ maxWidth: 130 }} aria-label={`Orçamento de ${c.name}`} />
                        <button className="secondary small">Salvar</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="section"><div><h2>Extrato</h2><p>Últimos 50 lançamentos.</p></div></div>
      <div className="card" style={{ padding: 0 }}>
        {f.ledger.length === 0 ? <div className="empty">Sem lançamentos.</div> : (
          <table>
            <thead><tr><th>Quando</th><th>Tipo</th><th>Descrição</th><th>Cliente</th><th className="num">Valor</th><th className="num">Saldo</th></tr></thead>
            <tbody>
              {f.ledger.map((l) => (
                <tr key={l.id}>
                  <td>{fmtDate(l.createdAt)}</td>
                  <td><span className={`badge ${l.type === 'CREDIT' ? 'ok' : l.type === 'DEBIT' ? 'warn' : ''}`}>{l.type === 'CREDIT' ? 'crédito' : l.type === 'DEBIT' ? 'consumo' : 'ajuste'}</span></td>
                  <td>{l.description}</td>
                  <td>{l.client?.name ?? <span className="dim">—</span>}</td>
                  <td className="num">{l.type === 'DEBIT' ? '−' : l.type === 'CREDIT' ? '+' : ''}{usd(l.amount.toString())}</td>
                  <td className="num">{usd(l.balanceAfter.toString())}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
