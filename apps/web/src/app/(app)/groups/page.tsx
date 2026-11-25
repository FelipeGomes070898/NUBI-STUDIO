import { prisma } from '@social-manager/db';
import Link from 'next/link';
import { Flash, type Search } from '@/components/Flash';
import { FORMATS, FORMAT_LABEL, PLATFORM_ICON, summarizePlatforms } from '@/lib/labels';
import { listGroups } from '@/server/directory';
import { getWorkspace } from '@/server/workspace';
import { createGroupAction } from './actions';

export const dynamic = 'force-dynamic';

export default async function GroupsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [groups, clients] = await Promise.all([listGroups(ws.id), prisma.client.findMany({ where: { workspaceId: ws.id }, orderBy: { name: 'asc' } })]);

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Grupos de contas</h1>
          <p>Um grupo reúne as contas que recebem o mesmo vídeo (ex.: 3 páginas do Facebook + TikTok + YouTube, todos verticais). Uma conta pode estar em vários grupos, e na hora de publicar você pode desmarcar qualquer uma.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <form action={createGroupAction} className="card">
        <h3>Novo grupo</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <label>Nome<input name="name" required maxLength={120} placeholder="ex.: Luciano ZEEN" /></label>
          <label>Formato padrão
            <select name="defaultFormat" defaultValue="VERTICAL_9_16">{FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</select>
          </label>
          <label>Cliente (opcional)
            <select name="clientId" defaultValue=""><option value="">— nenhum —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <label>Descrição<input name="description" /></label>
          <button>Criar grupo</button>
        </div>
      </form>

      <div className="section"><div><h2>{groups.length} grupo(s)</h2></div></div>
      {groups.length === 0 ? (
        <div className="card empty">Nenhum grupo ainda. Cadastre as contas em “Contas sociais” e depois monte seus grupos.</div>
      ) : (
        <div className="grid g3">
          {groups.map((g) => {
            const accounts = g.memberships.map((m) => m.account);
            return (
              <article className="card" key={g.id}>
                <div className="groupTop">
                  <span className="groupIcon">{g.name[0]?.toUpperCase()}</span>
                  <span>{!g.isActive && <span className="badge off">inativo</span>}<span className="badge">{FORMAT_LABEL[g.defaultFormat]}</span></span>
                </div>
                <h3>{g.name}</h3>
                {g.description && <p style={{ margin: '4px 0' }}>{g.description}</p>}
                <p style={{ margin: '6px 0 0' }}><strong style={{ color: 'var(--text)' }}>{summarizePlatforms(accounts)}</strong></p>
                <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>{accounts.map((a) => `${PLATFORM_ICON[a.platform]} ${a.displayName}`).join(' · ')}</div>
                <footer>
                  <span>{g.client ? `Cliente: ${g.client.name}` : 'Sem cliente'} · {accounts.length} conta(s)</span>
                  <Link href={`/groups/${g.id}`}>Gerenciar →</Link>
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
