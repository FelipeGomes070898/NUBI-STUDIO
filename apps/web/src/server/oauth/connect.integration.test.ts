/** Fluxo de conexão do YouTube contra Postgres real + Google simulado. Requer TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';

d('conexão YouTube (OAuth) — Postgres real', () => {
  let server: http.Server;
  let g: GoogleClientT;
  type GoogleClientT = import('./youtube').GoogleClient;
  let db: typeof import('@social-manager/db');
  let conn: typeof import('./connect');
  let crypto: typeof import('../crypto');
  const ws = 'ws_default';

  // estado controlável do "Google"
  let channel = { id: 'UC_luciano', title: 'Luciano ZEEN', customUrl: '@lucianozeen' };
  let tokenReply: () => { status: number; body: Record<string, unknown> };
  let revoked: string[] = [];
  let tokenCalls: Array<Record<string, string>> = [];

  const ok = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: SCOPES, token_type: 'Bearer', ...extra } });

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
        if (req.url === '/token') { tokenCalls.push(form); const r = tokenReply(); return json(r.status, r.body); }
        if (req.url === '/revoke') { revoked.push(form.token!); return json(200, {}); }
        if (req.url?.startsWith('/youtube/v3/channels')) {
          if (req.headers.authorization !== 'Bearer at-1' && req.headers.authorization !== 'Bearer at-2') return json(401, {});
          return json(200, { items: channel.id ? [{ id: channel.id, snippet: { title: channel.title, customUrl: channel.customUrl } }] : [] });
        }
        json(404, {});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    g = { clientId: 'cid', clientSecret: 'csecret', endpoints: { auth: `${base}/auth`, token: `${base}/token`, revoke: `${base}/revoke`, api: `${base}/youtube/v3` } };
  });
  afterAll(async () => { server?.close(); await db?.prisma.$disconnect(); });
  beforeEach(async () => {
    channel = { id: 'UC_luciano', title: 'Luciano ZEEN', customUrl: '@lucianozeen' };
    tokenReply = () => ok();
    revoked = []; tokenCalls = [];
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
  });

  const connect = (o: Partial<Parameters<typeof conn.connectYoutubeAccount>[0]> = {}) =>
    conn.connectYoutubeAccount({ workspaceId: ws, code: 'code-1', verifier: 'verif-1', redirectUri: 'https://app.test/cb', ...o }, g);

  it('sem conta escolhida: cria a conta com o nome do canal e guarda os tokens CRIPTOGRAFADOS', async () => {
    const r = await connect();
    expect(r.created).toBe(true);
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: r.account.id } });
    expect(a).toMatchObject({ platform: 'YOUTUBE', displayName: 'Luciano ZEEN', handle: '@lucianozeen', platformAccountId: 'UC_luciano', connectionStatus: 'CONNECTED' });
    expect(a.tokenCiphertext).not.toContain('at-1');
    expect(a.refreshTokenCiphertext).not.toContain('rt-1');
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('at-1');
    expect(crypto.decryptSecret(a.refreshTokenCiphertext!)).toBe('rt-1');
    expect(a.scopes).toContain('https://www.googleapis.com/auth/youtube.upload');
    // o code_verifier (PKCE) e o redirect_uri seguem na troca do código
    expect(tokenCalls[0]).toMatchObject({ grant_type: 'authorization_code', code: 'code-1', code_verifier: 'verif-1', redirect_uri: 'https://app.test/cb', client_secret: 'csecret' });
  });

  it('com conta escolhida: conecta o canal à conta cadastrada; recusa canal já usado em outra conta', async () => {
    const mine = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'YOUTUBE', displayName: 'Meu canal' } });
    const other = await db.prisma.socialAccount.create({ data: { workspaceId: ws, platform: 'YOUTUBE', displayName: 'Outro' } });
    const r = await connect({ accountId: mine.id });
    expect(r.created).toBe(false);
    expect(r.account.id).toBe(mine.id);
    expect(r.account.displayName).toBe('Meu canal'); // nome escolhido por você é mantido
    await expect(connect({ accountId: other.id })).rejects.toThrow(/já está conectado à conta "Meu canal"/);
  });

  it('reconectar o mesmo canal atualiza a conta existente (sem duplicar)', async () => {
    await connect();
    tokenReply = () => ok({ access_token: 'at-2', refresh_token: 'rt-2' });
    const r = await connect();
    expect(r.created).toBe(false);
    expect(await db.prisma.socialAccount.count()).toBe(1);
    expect(crypto.decryptSecret(r.account.tokenCiphertext!)).toBe('at-2');
  });

  it('exige todas as permissões e o refresh token', async () => {
    tokenReply = () => ok({ scope: 'https://www.googleapis.com/auth/youtube.readonly' });
    await expect(connect()).rejects.toThrow(/Autorização incompleta/);
    tokenReply = () => ok({ refresh_token: undefined });
    await expect(connect()).rejects.toThrow(/acesso permanente/);
    expect(await db.prisma.socialAccount.count()).toBe(0);
  });

  it('código inválido vira mensagem segura (sem vazar corpo do Google); conta sem canal é explicada', async () => {
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Bad code csecret-leak' } });
    const e = await connect().catch((x) => x);
    expect(e.message).toMatch(/recusou a autorização \(invalid_grant\)/);
    expect(e.message).not.toContain('leak');
    tokenReply = () => ok();
    channel = { id: '', title: '', customUrl: '' };
    await expect(connect()).rejects.toThrow(/não tem um canal/);
  });

  it('access token válido é reutilizado; expirado é renovado e salvo', async () => {
    const { account } = await connect();
    expect(await conn.getYoutubeAccessToken(ws, account.id, g)).toBe('at-1');
    expect(tokenCalls).toHaveLength(1); // nenhuma chamada extra ao Google

    await db.prisma.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    tokenReply = () => ok({ access_token: 'at-2', refresh_token: undefined });
    expect(await conn.getYoutubeAccessToken(ws, account.id, g)).toBe('at-2');
    expect(tokenCalls[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(crypto.decryptSecret(a.tokenCiphertext!)).toBe('at-2');
    expect(crypto.decryptSecret(a.refreshTokenCiphertext!)).toBe('rt-1'); // refresh antigo preservado
    expect(a.tokenExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('acesso revogado no Google (invalid_grant): conta vira EXPIRED e pede reconexão', async () => {
    const { account } = await connect();
    await db.prisma.socialAccount.update({ where: { id: account.id }, data: { tokenExpiresAt: new Date(Date.now() - 1000) } });
    tokenReply = () => ({ status: 400, body: { error: 'invalid_grant' } });
    await expect(conn.getYoutubeAccessToken(ws, account.id, g)).rejects.toThrow(/Reconecte/);
    expect((await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } })).connectionStatus).toBe('EXPIRED');
    await expect(conn.getYoutubeAccessToken(ws, account.id, g)).rejects.toThrow(/não está conectada/);
  });

  it('desconectar revoga no Google e apaga os tokens, mantendo a conta cadastrada', async () => {
    const { account } = await connect();
    const r = await conn.disconnectAccount(ws, account.id, g);
    expect(r.revoked).toBe(true);
    expect(revoked).toEqual(['rt-1']);
    const a = await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(a).toMatchObject({ tokenCiphertext: null, refreshTokenCiphertext: null, connectionStatus: 'PENDING_AUTH', scopes: [] });
    await expect(conn.getYoutubeAccessToken(ws, account.id, g)).rejects.toThrow(/não está conectada/);
  });

  it('isolamento: outro workspace não acessa nem desconecta a conta', async () => {
    const { account } = await connect();
    await expect(conn.getYoutubeAccessToken('outro', account.id, g)).rejects.toThrow(/não encontrada/);
    await expect(conn.disconnectAccount('outro', account.id, g)).rejects.toThrow(/não encontrada/);
  });

  it('URL de retorno: APP_URL > domínio de produção da Vercel > origem da requisição', () => {
    const save = { a: process.env.APP_URL, v: process.env.VERCEL_PROJECT_PRODUCTION_URL };
    delete process.env.APP_URL; delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(conn.youtubeRedirectUri('http://localhost:3000/x')).toBe('http://localhost:3000/api/oauth/youtube/callback');
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'nubi-studio.vercel.app';
    expect(conn.youtubeRedirectUri('https://preview-abc.vercel.app/x')).toBe('https://nubi-studio.vercel.app/api/oauth/youtube/callback');
    process.env.APP_URL = 'https://meu.dominio.com/';
    expect(conn.youtubeRedirectUri('https://qualquer.com')).toBe('https://meu.dominio.com/api/oauth/youtube/callback');
    process.env.APP_URL = save.a; process.env.VERCEL_PROJECT_PRODUCTION_URL = save.v;
    if (save.a === undefined) delete process.env.APP_URL;
    if (save.v === undefined) delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  });
});
