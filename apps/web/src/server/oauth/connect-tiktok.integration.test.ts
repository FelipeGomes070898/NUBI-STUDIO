/** Conexão do TikTok contra Postgres real + TikTok simulado. Requer TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('conexão TikTok (OAuth) — Postgres real', () => {
  let server: http.Server;
  let client: import('./tiktok').TiktokClient;
  let db: typeof import('@social-manager/db');
  let conn: typeof import('./connect');
  let crypto: typeof import('../crypto');
  const ws = 'ws_default';

  let tokenReply: () => { status: number; body: Record<string, unknown> };
  let profileReply: () => { status: number; body: Record<string, unknown> };
  let revoked: string[];
  let tokenCalls: Array<Record<string, string>>;
  let profileAuth: string[];

  const tokens = (extra: Record<string, unknown> = {}) => ({
    status: 200,
    body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'OPEN-1', scope: 'user.info.basic,video.upload,video.publish', token_type: 'Bearer', ...extra },
  });
  const profile = (name = 'Luciano ZEEN', id = 'OPEN-1') => ({ status: 200, body: { data: { user: { open_id: id, display_name: name } }, error: { code: 'ok', message: '' } } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    db = await import('@social-manager/db');
    conn = await import('./connect');
    crypto = await import('../crypto');

    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw));
        const json = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        const path = new URL(req.url!, 'http://x').pathname;
        if (path === '/v2/oauth/token/') { tokenCalls.push(form); const r = tokenReply(); return json(r.status, r.body); }
        if (path === '/v2/user/info/') { profileAuth.push(String(req.headers.authorization)); const r = profileReply(); return json(r.status, r.body); }
        if (path === '/v2/oauth/revoke/') { revoked.push(form.token!); return json(200, {}); }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    client = { clientKey: 'ck', clientSecret: 'csecret', endpoints: { auth: `${base}/auth`, token: `${base}/v2/oauth/token/`, userInfo: `${base}/v2/user/info/`, revoke: `${base}/v2/oauth/revoke/` } };
  });
  afterAll(async () => { server?.close(); await db?.prisma.$disconnect(); });
  beforeEach(async () => {
    tokenReply = () => tokens(); profileReply = () => profile();
    revoked = []; tokenCalls = []; profileAuth = [];
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
  });

  const connect = (o: Partial<Parameters<typeof conn.connectTiktokAccount>[0]> = {}) =>
    conn.connectTiktokAccount({ workspaceId: ws, code: 'code-1', redirectUri: 'https://app.test/cb', ...o }, client);

  it('sem conta escolhida: cria a conta com o nome do perfil e guarda os tokens CRIPTOGRAFADOS', async () => {
    const r = await connect();
    expect(r).toMatchObject({ created: true, canPublish: true });
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: r.account.id } });
    expect(a).toMatchObject({ platform: 'TIKTOK', displayName: 'Luciano ZEEN', platformAccountId: 'OPEN-1', connectionStatus: 'CONNECTED' });
    expect(a.tokenCiphertext).not.toContain('at-1');
    expect(a.refreshTokenCiphertext).not.toContain('rt-1');
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('at-1');
    expect(crypto.decryptSecret(a.refreshTokenCiphertext!)).toBe('rt-1');
    expect(a.scopes).toEqual(['user.info.basic', 'video.upload', 'video.publish']);
    expect(a.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(tokenCalls[0]).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', redirect_uri: 'https://app.test/cb', client_key: 'ck', client_secret: 'csecret' });
    expect(profileAuth[0]).toBe('Bearer at-1');
  });

  it('com conta escolhida: liga o perfil e mantém o nome cadastrado; recusa perfil já usado em outra conta', async () => {
    const mine = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'TIKTOK', displayName: 'Meu TikTok' } });
    const other = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'TIKTOK', displayName: 'Outro' } });
    const r = await connect({ accountId: mine.id });
    expect(r.account.id).toBe(mine.id);
    expect(r.account.displayName).toBe('Meu TikTok');
    await expect(connect({ accountId: other.id })).rejects.toThrow(/já está conectado à conta "Meu TikTok"/);
    const wrongPlatform = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'YOUTUBE', displayName: 'yt' } });
    await expect(connect({ accountId: wrongPlatform.id })).rejects.toThrow(/não é do TikTok/);
  });

  it('reconectar o mesmo perfil atualiza a conta existente (sem duplicar)', async () => {
    await connect();
    tokenReply = () => tokens({ access_token: 'at-2', refresh_token: 'rt-2' });
    const r = await connect();
    expect(r.created).toBe(false);
    expect(await db.prisma.socialAccount.count()).toBe(1);
    expect(crypto.decryptSecret(r.account.tokenCiphertext!)).toBe('at-2');
  });

  it('conecta sem permissão de vídeo, mas avisa que não publica; sem a identificação, recusa', async () => {
    tokenReply = () => tokens({ scope: 'user.info.basic' });
    const r = await connect();
    expect(r.canPublish).toBe(false);
    tokenReply = () => tokens({ scope: 'video.publish' });
    await expect(connect({ code: 'c2' })).rejects.toThrow(/Autorização incompleta/);
  });

  it('erros do TikTok (inclusive HTTP 200 com error) viram mensagem segura, sem vazar detalhes', async () => {
    tokenReply = () => ({ status: 200, body: { error: 'invalid_grant', error_description: 'bad code csecret-leak', log_id: 'x' } });
    const e = await connect().catch((x) => x);
    expect(e.message).toMatch(/recusou a autorização \(invalid_grant\)/);
    expect(e.message).not.toContain('leak');
    tokenReply = () => tokens();
    profileReply = () => ({ status: 200, body: { error: { code: 'access_token_invalid', message: 'secret at-1' } } });
    const e2 = await connect().catch((x) => x);
    expect(e2.message).toMatch(/access_token_invalid/);
    expect(e2.message).not.toContain('at-1');
    expect(await db.prisma.socialAccount.count()).toBe(0);
  });

  it('access token válido é reutilizado; expirado é renovado e o refresh token NOVO (girado) é salvo', async () => {
    const { account } = await connect();
    expect(await conn.getTiktokAccessToken(ws, account.id, client)).toBe('at-1');
    expect(tokenCalls).toHaveLength(1);

    await db.prisma.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    tokenReply = () => tokens({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(await conn.getTiktokAccessToken(ws, account.id, client)).toBe('at-2');
    expect(tokenCalls[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(crypto.decryptSecret(a.refreshTokenCiphertext!)).toBe('rt-2');
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('at-2');
  });

  it('refresh token revogado/expirado: conta vira EXPIRED e pede reconexão', async () => {
    const { account } = await connect();
    await db.prisma.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
    await expect(conn.getTiktokAccessToken(ws, account.id, client)).rejects.toThrow(/Reconecte/);
    expect((await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).connectionStatus).toBe('EXPIRED');
    await expect(conn.getTiktokAccessToken(ws, account.id, client)).rejects.toThrow(/não está conectada/);
  });

  it('desconectar revoga no TikTok e apaga os tokens, mantendo a conta; isolamento entre workspaces', async () => {
    const { account } = await connect();
    await expect(conn.disconnectAccount('outro', account.id, undefined, client)).rejects.toThrow(/não encontrada/);
    const r = await conn.disconnectAccount(ws, account.id, undefined, client);
    expect(r).toMatchObject({ revoked: true, platform: 'TIKTOK' });
    expect(revoked).toEqual(['at-1']);
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(a).toMatchObject({ tokenCiphertext: null, refreshTokenCiphertext: null, connectionStatus: 'PENDING_AUTH', scopes: [] });
  });
});
