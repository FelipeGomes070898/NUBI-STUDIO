/** Conexão de Páginas do Facebook contra Postgres real + Meta simulada. Requer TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('conexão Facebook (Páginas) — Postgres real', () => {
  let server: http.Server;
  let base = '';
  let client: import('./facebook').MetaClient;
  let db: typeof import('@social-manager/db');
  let conn: typeof import('./connect');
  let crypto: typeof import('../crypto');
  const ws = 'ws_default';

  const pageOf = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, access_token: `PT-${id}`, tasks: ['CREATE_CONTENT'], ...extra });
  const withIg = (id: string, username: string) => ({ instagram_business_account: { id, username, name: `Nome ${username}` } });
  let pages: Array<Record<string, unknown>>;
  let granted: Array<{ permission: string; status: string }>;
  let secondPage: Array<Record<string, unknown>> | null; // para testar paginação
  let failWith: number | null;
  let calls: Array<{ path: string; q: Record<string, string> }>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    db = await import('@social-manager/db');
    conn = await import('./connect');
    crypto = await import('../crypto');

    server = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      const q = Object.fromEntries(u.searchParams);
      calls.push({ path: u.pathname, q });
      const json = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (failWith) return json(400, { error: { message: 'Invalid token PT-secret', type: 'OAuthException', code: failWith } });
      if (u.pathname === '/graph/oauth/access_token') {
        if (q.grant_type === 'fb_exchange_token') return json(200, { access_token: 'LONG-USER', token_type: 'bearer', expires_in: 5184000 });
        return json(200, { access_token: 'SHORT-USER', token_type: 'bearer', expires_in: 3600 });
      }
      if (u.pathname === '/graph/me/permissions') return json(200, { data: granted });
      if (u.pathname === '/graph/me/accounts') {
        if (q.after === '1') return json(200, { data: secondPage ?? [] });
        return json(200, { data: pages, ...(secondPage ? { paging: { next: `${base}/graph/me/accounts?after=1&access_token=${q.access_token}` } } : {}) });
      }
      json(404, {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = { appId: 'APP1', appSecret: 'SECRET1', endpoints: { graph: `${base}/graph`, dialog: `${base}/dialog` } };
  });
  afterAll(async () => { server?.close(); await db?.prisma.$disconnect(); });
  beforeEach(async () => {
    pages = [pageOf('111', 'Página Um', { username: 'paginaum' }), pageOf('222', 'Página Dois'), pageOf('333', 'Página Três')];
    granted = [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'pages_read_engagement', status: 'declined' }];
    secondPage = null; failWith = null; calls = [];
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
  });

  const connect = (o: Partial<Parameters<typeof conn.connectFacebookPages>[0]> = {}) =>
    conn.connectFacebookPages({ workspaceId: ws, code: 'code-1', redirectUri: 'https://app.test/cb', ...o }, client);

  it('cria uma conta por Página liberada e guarda o token DA PÁGINA criptografado', async () => {
    const r = await connect();
    expect(r.connected.map((c) => c.page)).toEqual(['Página Um', 'Página Dois', 'Página Três']);
    const a = await db.prisma.socialAccount.findFirstOrThrow({ where: { platformAccountId: '111' } });
    expect(a).toMatchObject({ platform: 'FACEBOOK', displayName: 'Página Um', handle: '@paginaum', connectionStatus: 'CONNECTED', refreshTokenCiphertext: null, tokenExpiresAt: null });
    expect(a.tokenCiphertext).not.toContain('PT-111');
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('PT-111'); // token da página, não o do usuário
    expect(a.scopes).toEqual(['pages_show_list', 'pages_manage_posts']); // só as concedidas
    expect(await db.prisma.socialAccount.count()).toBe(3);
  });

  it('troca código → token curto → token longo e usa o token longo para listar páginas', async () => {
    await connect();
    const ex = calls.filter((c) => c.path === '/graph/oauth/access_token');
    expect(ex[0]!.q).toMatchObject({ client_id: 'APP1', client_secret: 'SECRET1', redirect_uri: 'https://app.test/cb', code: 'code-1' });
    expect(ex[1]!.q).toMatchObject({ grant_type: 'fb_exchange_token', fb_exchange_token: 'SHORT-USER' });
    expect(calls.find((c) => c.path === '/graph/me/accounts')!.q.access_token).toBe('LONG-USER');
  });

  it('reconectar atualiza as mesmas contas (sem duplicar) e renova o token', async () => {
    await connect();
    pages = pages.map((p) => ({ ...p, access_token: `NEW-${p.id}` }));
    const r = await connect();
    expect(r.connected.every((c) => !c.created)).toBe(true);
    expect(await db.prisma.socialAccount.count()).toBe(3);
    const a = await db.prisma.socialAccount.findFirstOrThrow({ where: { platformAccountId: '222' } });
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('NEW-222');
  });

  it('conta escolhida + uma única Página: liga a Página à conta e mantém o nome cadastrado', async () => {
    const mine = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'FACEBOOK', displayName: 'Luciano ZEEN — Facebook 1' } });
    pages = [pageOf('777', 'Nome Real da Página')];
    const r = await connect({ accountId: mine.id });
    expect(r.connected).toEqual([{ accountId: mine.id, page: 'Nome Real da Página', created: false }]);
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: mine.id } });
    expect(a).toMatchObject({ displayName: 'Luciano ZEEN — Facebook 1', platformAccountId: '777', connectionStatus: 'CONNECTED' });
    expect(await db.prisma.socialAccount.count()).toBe(1);
  });

  it('conta escolhida + várias Páginas: liga pelo nome; sem nome igual, não adivinha e avisa', async () => {
    const byName = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'FACEBOOK', displayName: 'página dois' } });
    const r1 = await connect({ accountId: byName.id });
    expect(r1.connected.find((c) => c.page === 'Página Dois')!.accountId).toBe(byName.id);
    expect(r1.note).toBeUndefined();

    await db.prisma.$executeRawUnsafe(`TRUNCATE "SocialAccount" CASCADE`);
    const other = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'FACEBOOK', displayName: 'Nome sem par' } });
    const r2 = await connect({ accountId: other.id });
    expect(r2.note).toMatch(/nenhuma tem o nome "Nome sem par"/);
    const untouched = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched).toMatchObject({ platformAccountId: null, connectionStatus: 'PENDING_AUTH', tokenCiphertext: null });
    expect(await db.prisma.socialAccount.count()).toBe(4); // 3 páginas + a conta que ficou como estava
  });

  it('recusa ligar uma Página que já pertence a outra conta', async () => {
    await connect(); // 111 já conectada à conta "Página Um"
    const mine = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'FACEBOOK', displayName: 'Outra' } });
    pages = [pageOf('111', 'Página Um')];
    await expect(connect({ accountId: mine.id })).rejects.toThrow(/já está conectada à conta "Página Um"/);
  });

  it('segue a paginação do Graph e recusa link de paginação para outro host', async () => {
    secondPage = [pageOf('444', 'Página Quatro')];
    const r = await connect();
    expect(r.connected).toHaveLength(4);

    await db.prisma.$executeRawUnsafe(`TRUNCATE "SocialAccount" CASCADE`);
    calls = [];
    const evil = http.createServer((_q, s) => s.end('{}'));
    await new Promise<void>((ok) => evil.listen(0, '127.0.0.1', ok));
    const evilBase = `http://127.0.0.1:${(evil.address() as AddressInfo).port}`;
    const orig = server.listeners('request')[0] as http.RequestListener;
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/graph/me/accounts') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: pages, paging: { next: `${evilBase}/steal` } }));
      orig(req, res);
    });
    await expect(connect()).rejects.toThrow(/outro endereço/);
    evil.close();
    server.removeAllListeners('request'); server.on('request', orig);
  });

  it('exige a permissão de publicar e ao menos uma Página', async () => {
    granted = [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'declined' }];
    await expect(connect()).rejects.toThrow(/falta a permissão de publicar/);
    granted = [{ permission: 'pages_manage_posts', status: 'granted' }];
    pages = [];
    await expect(connect()).rejects.toThrow(/Nenhuma Página foi liberada/);
    expect(await db.prisma.socialAccount.count()).toBe(0);
  });

  it('erro da Meta vira mensagem segura (só o código, sem vazar token)', async () => {
    failWith = 190;
    const e = await connect().catch((x) => x);
    expect(e.message).toMatch(/código 190/);
    expect(e.message).not.toContain('PT-secret');
  });

  it('token da página: disponível só se conectada; desconectar apaga; expirada exige reconexão', async () => {
    const r = await connect();
    const id = r.connected[0]!.accountId;
    expect(await conn.getFacebookPageToken(ws, id)).toBe('PT-111');

    await conn.markFacebookExpired(ws, id);
    await expect(conn.getFacebookPageToken(ws, id)).rejects.toThrow(/não está conectada/);

    const id2 = r.connected[1]!.accountId;
    const out = await conn.disconnectAccount(ws, id2);
    expect(out).toMatchObject({ revoked: false, platform: 'FACEBOOK' });
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: id2 } });
    expect(a).toMatchObject({ tokenCiphertext: null, connectionStatus: 'PENDING_AUTH', scopes: [] });
    expect(a.platformAccountId).toBe('222'); // continua associada à Página para reconectar
    await expect(conn.getFacebookPageToken('outro', id2)).rejects.toThrow(/não encontrada/);
  });

  describe('Instagram (ligado à Página)', () => {
    const IG_GRANTED = [{ permission: 'pages_show_list', status: 'granted' }, { permission: 'pages_manage_posts', status: 'granted' }, { permission: 'instagram_basic', status: 'granted' }, { permission: 'instagram_content_publish', status: 'granted' }];

    it('cadastra uma conta do Instagram por Página que tenha conta Profissional ligada, com o token da Página', async () => {
      granted = IG_GRANTED;
      pages = [pageOf('111', 'Página Um', withIg('ig-1', 'luciano.zeen')), pageOf('222', 'Página Dois'), pageOf('333', 'Página Três', withIg('ig-3', 'canal.tres'))];
      const r = await connect({ includeInstagram: true });
      expect(r.instagram.map((i) => i.username).sort()).toEqual(['canal.tres', 'luciano.zeen']);
      expect(r.pagesWithoutInstagram).toEqual(['Página Dois']);
      const ig = await db.prisma.socialAccount.findFirstOrThrow({ where: { platform: 'INSTAGRAM', platformAccountId: 'ig-1' } });
      expect(ig).toMatchObject({ displayName: 'luciano.zeen', handle: '@luciano.zeen', connectionStatus: 'CONNECTED' });
      expect(crypto.decryptSecret(ig.tokenCiphertext!)).toBe('PT-111'); // token da Página
      expect(await db.prisma.socialAccount.count({ where: { platform: 'FACEBOOK' } })).toBe(3);
      expect(calls.find((c) => c.path === '/graph/me/accounts')!.q.fields).toContain('instagram_business_account');
    });

    it('reconectar não duplica; sem a permissão do Instagram o login é recusado', async () => {
      granted = IG_GRANTED;
      pages = [pageOf('111', 'Página Um', withIg('ig-1', 'luciano.zeen'))];
      await connect({ includeInstagram: true });
      pages = [pageOf('111', 'Página Um', withIg('ig-1', 'luciano.zeen'))].map((p) => ({ ...p, access_token: 'NOVO' }));
      const r = await connect({ includeInstagram: true });
      expect(r.instagram[0]!.created).toBe(false);
      expect(await db.prisma.socialAccount.count({ where: { platform: 'INSTAGRAM' } })).toBe(1);
      expect(crypto.decryptSecret((await db.prisma.socialAccount.findFirstOrThrow({ where: { platform: 'INSTAGRAM' } })).tokenCiphertext!)).toBe('NOVO');

      granted = [{ permission: 'pages_manage_posts', status: 'granted' }, { permission: 'instagram_content_publish', status: 'declined' }];
      await expect(connect({ includeInstagram: true })).rejects.toThrow(/permissão de publicar no Instagram/);
    });

    it('o botão do Facebook (sem Instagram) não cria contas do Instagram, mesmo que a Página tenha uma', async () => {
      pages = [pageOf('111', 'Página Um', withIg('ig-1', 'luciano.zeen'))];
      const r = await connect();
      expect(r.instagram).toEqual([]);
      expect(await db.prisma.socialAccount.count({ where: { platform: 'INSTAGRAM' } })).toBe(0);
    });

    it('token da conta do Instagram sai da mesma conexão; desconectar limpa', async () => {
      granted = IG_GRANTED;
      pages = [pageOf('111', 'Página Um', withIg('ig-1', 'luciano.zeen'))];
      const r = await connect({ includeInstagram: true });
      const id = r.instagram[0]!.accountId;
      expect(await conn.getFacebookPageToken(ws, id)).toBe('PT-111');
      expect(await conn.disconnectAccount(ws, id)).toMatchObject({ platform: 'INSTAGRAM', revoked: false });
      await expect(conn.getFacebookPageToken(ws, id)).rejects.toThrow(/não está conectada ao Instagram/);
    });
  });
});
