import { prisma } from '@social-manager/db';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Flash, type Search } from '@/components/Flash';
import { FORMATS, FORMAT_LABEL, PLATFORMS, PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/labels';
import { getWorkspace } from '@/server/workspace';
import { deleteGroupAction, saveGroupAction, saveMembersAction, setGroupCharacterAction } from '../actions';

export const dynamic = 'force-dynamic';

export default async function GroupPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const [{ id }, q] = await Promise.all([params, searchParams]);
  const ws = await getWorkspace();
  const group = await prisma.accountGroup.findFirst({ where: { id, workspaceId: ws.id }, include: { memberships: true } });
  if (!group) notFound();
  const characters = await prisma.character.findMany({ where: { workspaceId: ws.id }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const [accounts, clients] = await Promise.all([
    prisma.socialAccount.findMany({ where: { workspaceId: ws.id }, orderBy: [{ platform: 'asc' }, { displayName: 'asc' }], include: { memberships: { include: { group: { select: { id: true, name: true } } } } } }),
    prisma.client.findMany({ where: { workspaceId: ws.id }, orderBy: { name: 'asc' } }),
  ]);
  const members = new Set(group.memberships.map((m) => m.socialAccountId));

  return (
    <>
      <div className="pageHead">
        <div>
          <p style={{ margin: 0 }}><Link href="/groups">← Grupos</Link></p>
          <h1>{group.name}</h1>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <form action={saveGroupAction} className="card stack">
        <input type="hidden" name="entityId" value={group.id} />
        <h3>Configuração</h3>
        <div className="row">
          <label>Nome<input name="name" defaultValue={group.name} required maxLength={120} /></label>
          <label>Formato padrão
            <select name="defaultFormat" defaultValue={group.defaultFormat}>{FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f]}</option>)}</select>
          </label>
          <label>Cliente
            <select name="clientId" defaultValue={group.clientId ?? ''}><option value="">— nenhum —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        </div>
        <label>Descrição<input name="description" defaultValue={group.description ?? ''} /></label>
        <div className="row">
          <label className="inline noflex"><input type="checkbox" name="isActive" defaultChecked={group.isActive} /> Grupo ativo</label>
          <button>Salvar configuração</button>
        </div>
      </form>

      <form action={setGroupCharacterAction} className="card stack" style={{ marginTop: 14 }}>
        <input type="hidden" name="entityId" value={group.id} />
        <div>
          <h3>Personagem fixo</h3>
          <p style={{ margin: '4px 0 0' }}>Quando você pedir um vídeo para este grupo no <Link href="/studio">Estúdio</Link>, este personagem entra automaticamente (dá para trocar na hora). Cadastre personagens em <Link href="/characters">Personagens</Link>.</p>
        </div>
        <div className="row">
          <label>Personagem
            <select name="characterId" defaultValue={group.characterId ?? ''}>
              <option value="">— nenhum —</option>
              {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <button>Salvar personagem</button>
        </div>
      </form>

      <form action={saveMembersAction} className="card stack" style={{ marginTop: 14 }}>
        <input type="hidden" name="entityId" value={group.id} />
        <div>
          <h3>Contas do grupo</h3>
          <p style={{ margin: '4px 0 0' }}>Marque as contas que fazem parte deste grupo. O grupo sugere os destinos; você ainda poderá desmarcar contas ao programar uma publicação.</p>
        </div>
        {accounts.length === 0 ? (
          <div className="empty">Nenhuma conta cadastrada. <Link href="/accounts">Cadastre contas sociais</Link> primeiro.</div>
        ) : (
          PLATFORMS.filter((p) => accounts.some((a) => a.platform === p)).map((p) => (
            <div key={p}>
              <div className="dim" style={{ fontSize: 12, margin: '4px 0 8px' }}>{PLATFORM_ICON[p]} {PLATFORM_LABEL[p]}</div>
              <div className="checks">
                {accounts.filter((a) => a.platform === p).map((a) => {
                  const others = a.memberships.filter((m) => m.group.id !== group.id).map((m) => m.group.name);
                  return (
                    <label className="inline" key={a.id}>
                      <input type="checkbox" name="accountIds" value={a.id} defaultChecked={members.has(a.id)} />
                      <span>
                        {a.displayName} {!a.isActive && <span className="badge off">inativa</span>}
                        {others.length > 0 && <small style={{ display: 'block' }}>também em: {others.join(', ')}</small>}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))
        )}
        <div><button disabled={accounts.length === 0}>Salvar contas do grupo</button></div>
      </form>

      <form action={deleteGroupAction} style={{ marginTop: 22 }}>
        <input type="hidden" name="entityId" value={group.id} />
        <button className="danger small">Excluir grupo</button> <small>As contas continuam cadastradas.</small>
      </form>
    </>
  );
}
