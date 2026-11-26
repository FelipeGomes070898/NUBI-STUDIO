import { prisma } from '@social-manager/db';
import { Flash, type Search } from '@/components/Flash';
import { PLATFORMS, PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/labels';
import { getWorkspace } from '@/server/workspace';
import { facebookConfigured, youtubeConfigured } from '@/server/oauth/connect';
import { createAccountAction, deleteAccountAction, disconnectAccountAction, toggleAccountAction } from './actions';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, [string, string]> = {
  PENDING_AUTH: ['aguardando OAuth', 'warn'],
  CONNECTED: ['conectada', 'ok'],
  EXPIRED: ['token expirado', 'err'],
  REVOKED: ['acesso revogado', 'err'],
};

export default async function AccountsPage({ searchParams }: { searchParams: Search }) {
  const q = await searchParams;
  const yt = youtubeConfigured();
  const fb = facebookConfigured();
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
          <p>Cada página, canal ou perfil individual. Conecte o canal com o login da conta (OAuth) para o sistema poder publicar. Contas cadastradas à mão ficam “aguardando OAuth”. YouTube e Facebook já têm conexão; o TikTok virá depois.</p>
        </div>
      </div>
      <Flash ok={q.ok} error={q.error} />

      <div className="card">
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <h3>Conectar canal do YouTube</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>Entre com a conta Google, escolha o canal e autorize. O canal é cadastrado e conectado de uma vez.</p>
            {!yt && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--warn)' }}>Falta configurar <code>GOOGLE_CLIENT_ID</code> e <code>GOOGLE_CLIENT_SECRET</code> na Vercel (e fazer um novo deploy).</p>}
          </div>
          <div className="noflex">{yt ? <a className="btn" href="/api/oauth/youtube/start">Conectar com YouTube</a> : <button disabled>Conectar com YouTube</button>}</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ alignItems: 'center' }}>
          <div>
            <h3>Conectar páginas do Facebook</h3>
            <p style={{ margin: '4px 0 0', fontSize: 13 }}>Entre com o Facebook e, na tela da Meta, escolha as Páginas que o sistema pode usar. Cada Página escolhida vira uma conta conectada.</p>
            {!fb && <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--warn)' }}>Falta configurar <code>META_APP_ID</code> e <code>META_APP_SECRET</code> na Vercel (e fazer um novo deploy).</p>}
          </div>
          <div className="noflex">{fb ? <a className="btn" href="/api/oauth/facebook/start">Conectar com Facebook</a> : <button disabled>Conectar com Facebook</button>}</div>
        </div>
      </div>

      <form action={createAccountAction} className="card" style={{ marginTop: 14 }}>
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
                    <td>
                      <span className={`badge ${tone}`}>{label}</span>
                      {a.connectionStatus === 'CONNECTED' && a.tokenExpiresAt && <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>acesso renova sozinho</div>}
                    </td>
                    <td>{a.memberships.length ? a.memberships.map((m) => m.group.name).join(', ') : <span className="dim">—</span>}</td>
                    <td>{a.client?.name ?? <span className="dim">—</span>}</td>
                    <td className="num">
                      {a.platform === 'FACEBOOK' && fb && (
                        <><a className="btn secondary small" href={`/api/oauth/facebook/start?accountId=${a.id}`}>{a.connectionStatus === 'CONNECTED' ? 'Reconectar' : 'Conectar'}</a>{' '}</>
                      )}
                      {a.platform === 'YOUTUBE' && yt && (
                        <><a className="btn secondary small" href={`/api/oauth/youtube/start?accountId=${a.id}`}>{a.connectionStatus === 'CONNECTED' ? 'Reconectar' : 'Conectar'}</a>{' '}</>
                      )}
                      {a.connectionStatus === 'CONNECTED' && (
                        <><form action={disconnectAccountAction} style={{ display: 'inline' }}><input type="hidden" name="entityId" value={a.id} /><button className="secondary small">Desconectar</button></form>{' '}</>
                      )}
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
