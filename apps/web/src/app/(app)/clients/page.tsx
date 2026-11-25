import { prisma } from '@social-manager/db';
import { Flash, type Search } from '@/components/Flash';
import { usd } from '@/server/ai/pricing';
import { getWorkspace } from '@/server/workspace';
import { budgetAction, createClientAction, deleteClientAction, toggleClientAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function ClientsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const clients = await prisma.client.findMany({
    where: { workspaceId: ws.id },
    orderBy: { name: 'asc' },
    include: { _count: { select: { groups: true, accounts: true } } },
  });

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Clientes</h1>
          <p>Cada cliente ou marca. Serve para organizar e para limitar o consumo de IA. Grupos de contas são independentes: um cliente pode ter vários grupos, ou nenhum.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <form action={createClientAction} className="card">
        <h3>Novo cliente</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <label>Nome<input name="name" required maxLength={120} /></label>
          <label>Orçamento mensal de IA (USD, opcional)<input name="monthlyBudget" inputMode="decimal" placeholder="ex.: 25" /></label>
          <label>Observações<input name="notes" /></label>
          <button>Criar cliente</button>
        </div>
      </form>

      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        {clients.length === 0 ? (
          <div className="empty">Nenhum cliente ainda.</div>
        ) : (
          <table>
            <thead><tr><th>Cliente</th><th>Grupos</th><th>Contas</th><th>Orçamento mensal (IA)</th><th></th></tr></thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>
                    <strong>{c.name}</strong> {!c.isActive && <span className="badge off">inativo</span>}
                    {c.notes && <div className="dim">{c.notes}</div>}
                  </td>
                  <td>{c._count.groups}</td>
                  <td>{c._count.accounts}</td>
                  <td>
                    <form action={budgetAction} className="row" style={{ flexWrap: 'nowrap' }}>
                      <input type="hidden" name="entityId" value={c.id} />
                      <input name="monthlyBudget" inputMode="decimal" defaultValue={c.monthlyBudget?.toString() ?? ''} placeholder="sem limite" style={{ maxWidth: 120 }} aria-label={`Orçamento de ${c.name}`} />
                      <button className="secondary small">Salvar</button>
                    </form>
                    {c.monthlyBudget && <small>{usd(c.monthlyBudget.toString())}/mês</small>}
                  </td>
                  <td className="num">
                    <form action={toggleClientAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="entityId" value={c.id} />
                      <input type="hidden" name="active" value={String(!c.isActive)} />
                      <button className="secondary small">{c.isActive ? 'Desativar' : 'Ativar'}</button>
                    </form>{' '}
                    <form action={deleteClientAction} style={{ display: 'inline' }}>
                      <input type="hidden" name="entityId" value={c.id} />
                      <button className="danger small">Excluir</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
