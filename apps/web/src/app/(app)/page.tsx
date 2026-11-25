import { prisma } from '@social-manager/db';
import Link from 'next/link';
import { FORMAT_LABEL, summarizePlatforms } from '@/lib/labels';
import { usd } from '@/server/ai/pricing';
import { getFinanceOverview } from '@/server/billing/wallet';
import { listGroups } from '@/server/directory';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const ws = await getWorkspace();
  const [clients, accounts, jobs, groups, providers, activeModels, fin] = await Promise.all([
    prisma.client.count({ where: { workspaceId: ws.id } }),
    prisma.socialAccount.count({ where: { workspaceId: ws.id } }),
    prisma.aIJob.count({ where: { workspaceId: ws.id } }),
    listGroups(ws.id),
    prisma.aIProvider.findMany({ where: { workspaceId: ws.id } }),
    prisma.aIModel.count({ where: { isActive: true, provider: { workspaceId: ws.id } } }),
    getFinanceOverview(ws.id),
  ]);
  const primary = providers.find((p) => p.isPrimary);

  return (
    <>
      <div className="pageHead">
        <div><h1>Central de operações</h1><p>Grupos de contas, estúdio de IA e carteira num só lugar.</p></div>
      </div>

      <div className="grid g4">
        <div className="stat"><small>Clientes</small><strong>{clients}</strong></div>
        <div className="stat"><small>Grupos</small><strong>{groups.length}</strong></div>
        <div className="stat"><small>Contas cadastradas</small><strong>{accounts}</strong><span>conexão OAuth: etapa futura</span></div>
        <div className="stat"><small>Gerações de IA</small><strong>{jobs}</strong></div>
      </div>

      <div className="section"><div><h2>Grupos de publicação</h2><p>Independentes de clientes; uma conta pode estar em mais de um grupo.</p></div><Link className="btn secondary" href="/groups">Gerenciar grupos</Link></div>
      {groups.length === 0 ? (
        <div className="card empty">Nenhum grupo ainda. Cadastre suas <Link href="/accounts">contas</Link> e crie o primeiro <Link href="/groups">grupo</Link>.</div>
      ) : (
        <div className="grid g3">
          {groups.slice(0, 6).map((g) => (
            <article className="card" key={g.id}>
              <div className="groupTop"><span className="groupIcon">{g.name[0]?.toUpperCase()}</span><span className="badge">{FORMAT_LABEL[g.defaultFormat]}</span></div>
              <h3>{g.name}</h3>
              <p style={{ margin: '6px 0 0' }}><strong style={{ color: 'var(--text)' }}>{summarizePlatforms(g.memberships.map((m) => m.account))}</strong></p>
              <footer><span>{g.memberships.length} conta(s)</span><Link href={`/groups/${g.id}`}>Gerenciar →</Link></footer>
            </article>
          ))}
        </div>
      )}

      <div className="section"><div><h2>Central de IA</h2></div><Link className="btn secondary" href="/ai">Configurar</Link></div>
      <div className="card">
        {providers.length === 0 ? (
          <p style={{ margin: 0 }}>Nenhum gateway conectado. Cadastre a chave em <Link href="/ai">Central de IA</Link>, teste a conexão e sincronize os modelos.</p>
        ) : (
          <p style={{ margin: 0 }}><strong style={{ color: 'var(--text)' }}>{providers.length}</strong> provedor(es){primary && <> · principal: <strong style={{ color: 'var(--text)' }}>{primary.name}</strong></>} · <strong style={{ color: 'var(--text)' }}>{activeModels}</strong> modelo(s) ativo(s). <Link href="/ai/studio">Abrir estúdio →</Link></p>
        )}
      </div>

      <div className="section"><div><h2>Carteira</h2></div><Link className="btn secondary" href="/billing">Ver financeiro</Link></div>
      <div className="grid g3">
        <div className="stat"><small>Saldo</small><strong>{usd(fin.balance)}</strong></div>
        <div className="stat"><small>Consumo no mês</small><strong>{usd(fin.monthSpent)}</strong></div>
        <div className="stat"><small>Retido em andamento</small><strong>{usd(fin.reserved)}</strong></div>
      </div>
    </>
  );
}
