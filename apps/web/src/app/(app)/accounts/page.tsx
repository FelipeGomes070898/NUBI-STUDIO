import { prisma } from '@social-manager/db';
import { Flash, type Search } from '@/components/Flash';
import { PLATFORMS, PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/labels';
import { getWorkspace } from '@/server/workspace';
import { createAccountAction, deleteAccountAction, toggleAccountAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, [string, string]> = {
  PENDING_AUTH: ['aguardando OAuth', 'warn'],
  CONNECTED: ['conectada', 'ok'],
  EXPIRED: ['token expirado', 'err'],
  REVOKED: ['acesso revogado', 'err'],
};

export default async function AccountsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const ws = await getWorkspace();
  const [accounts, clients] = await Promise.all([
    prisma.socialAccount.findMany({
      where: { workspaceId: ws.id },
      orderBy: [{ platform: 'asc' }, { displayName: 'asc' }],
      include: { client: { select: { name: true } }, memberships: { include: { group: { select: { name: true } } } } },
    }),
    prisma.client.findMany({ where: { workspaceId: ws.id }, orderBy: { name: 'asc' } }),
  ]);

  return (
    <>
      <div className="pageHead">
        <div>
          <h1>Contas sociais</h1>
          <p>Cada página, canal ou perfil individual. Por enquanto o cadastro é manual; a conexão OAuth (necessária para publicar) é uma etapa futura e as contas ficam “aguardando OAuth”.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <form action={createAccountAction} className="card">
        <h3>Nova conta</h3>
        <div className="row" style={{ marginTop: 12 }}>
          <label>Plataforma
            <select name="platform" defaultValue="FACEBOOK">{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select>
          </label>
          <label>Nome da conta/página/canal<input name="displayName" required maxLength={120} /></label>
          <label>@usuário (opcional)<input name="handle" /></label>
          <label>Cliente (opcional)
            <select name="clientId" defaultValue=""><option value="">— nenhum —</option>{clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
          <button>Cadastrar</button>
        </div>
      </form>

      <div className="card" style={{ marginTop: 14, padding: 0 }}>
        {accounts.length === 0 ? (
          <div className="empty">Nenhuma conta cadastrada.</div>
        ) : (
          <table>
            <thead><tr><th>Conta</th><th>Status</th><th>Grupos</th><th>Cliente</th><th></th></tr></thead>
            <tbody>
              {accounts.map((a) => {
                const [label, tone] = STATUS[a.connectionStatus]!;
                return (
                  <tr key={a.id}>
                    <td>
                      <span className="badge">{PLATFORM_ICON[a.platform]} {PLATFORM_LABEL[a.platform]}</span> <strong>{a.displayName}</strong>
                      {a.handle && <span className="dim"> {a.handle}</span>} {!a.isActive && <span className="badge off">inativa</span>}
                    </td>
                    <td><span className={`badge ${tone}`}>{label}</span></td>
                    <td>{a.memberships.length ? a.memberships.map((m) => m.group.name).join(', ') : <span className="dim">—</span>}</td>
                    <td>{a.client?.name ?? <span className="dim">—</span>}</td>
                    <td className="num">
                      <form action={toggleAccountAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="entityId" value={a.id} /><input type="hidden" name="active" value={String(!a.isActive)} />
                        <button className="secondary small">{a.isActive ? 'Desativar' : 'Ativar'}</button>
                      </form>{' '}
                      <form action={deleteAccountAction} style={{ display: 'inline' }}>
                        <input type="hidden" name="entityId" value={a.id} /><button className="danger small">Excluir</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
