import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublishError, type PublishAccount, type PublishAuth, type PublishInput } from '../types';
import { facebookPublisher } from './facebook';
import { tiktokPublisher } from './tiktok';
import { youtubePublisher } from './youtube';

// vídeo "falso" de 25.000 bytes com padrão previsível (para provar que chega byte a byte igual)
const VIDEO = Buffer.from(Array.from({ length: 25_000 }, (_, i) => (i * 7 + 3) % 251));

let server: http.Server;
let base = '';
let log: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: Buffer }>;
let handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      if (req.url === '/media.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': VIDEO.length }).end(VIDEO);
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { log = []; handler = (_r, _b, res) => res.writeHead(404).end('{}'); });

const json = (res: http.ServerResponse, status: number, o: unknown, headers: Record<string, string> = {}) =>
  res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(o));

const input = (o: Partial<PublishInput> = {}): PublishInput => ({
  title: 'Meu vídeo', description: 'Descrição #teste', visibility: 'PUBLIC',
  media: { url: `${base}/media.mp4`, sizeBytes: VIDEO.length, mimeType: 'video/mp4', durationSec: 30 }, ...o,
});
const acct = (o: Partial<PublishAccount> = {}): PublishAccount => ({ id: 'a1', displayName: 'Conta', platformAccountId: 'PAGE1', scopes: [], ...o });
let rejected = 0;
const auth: PublishAuth = { getToken: async () => 'TOKEN-1', onTokenRejected: async () => { rejected++; } };
beforeEach(() => { rejected = 0; });

describe('YouTube', () => {
  const yt = () => youtubePublisher({ uploadBase: `${base}/upload/youtube/v3` });

  it('cria a sessão retomável e transmite o vídeo byte a byte igual', async () => {
    let received: Buffer = Buffer.alloc(0);
    handler = (req, body, res) => {
      if (req.url!.startsWith('/upload/youtube/v3/videos')) return void json(res, 200, {}, { location: `${base}/session/s1` });
      if (req.url === '/session/s1') { received = body; return void json(res, 200, { id: 'VID1', status: { privacyStatus: 'public' } }); }
      res.writeHead(404).end();
    };
    const r = await yt().publish(acct(), input(), auth);
    expect(r).toEqual({ platformPostId: 'VID1', url: 'https://www.youtube.com/watch?v=VID1', note: undefined });
    expect(received.equals(VIDEO)).toBe(true);
    const init = log.find((l) => l.path.startsWith('/upload/youtube/v3/videos'))!;
    expect(init.headers.authorization).toBe('Bearer TOKEN-1');
    expect(init.headers['x-upload-content-length']).toBe('25000');
    expect(JSON.parse(init.body.toString())).toMatchObject({ snippet: { title: 'Meu vídeo', description: 'Descrição #teste' }, status: { privacyStatus: 'public', selfDeclaredMadeForKids: false } });
    expect(log.find((l) => l.path === '/session/s1')!.headers['content-length']).toBe('25000');
    expect(log.find((l) => l.path === '/session/s1')!.headers.authorization).toBeUndefined(); // o link da sessão não leva token
  });

  it('visibilidade privada e aviso quando o YouTube força privado (projeto sem auditoria)', async () => {
    handler = (req, _b, res) => (req.url === '/session/s1' ? json(res, 200, { id: 'V2', status: { privacyStatus: 'private' } }) : json(res, 200, {}, { location: `${base}/session/s1` }));
    const r = await yt().publish(acct(), input(), auth);
    expect(r.note).toMatch(/ficam privados/);
    await yt().publish(acct(), input({ visibility: 'PRIVATE' }), auth);
    const inits = log.filter((l) => l.path.startsWith('/upload/youtube/v3/videos'));
    expect(JSON.parse(inits[1]!.body.toString()).status.privacyStatus).toBe('private');
  });

  it('traduz cota esgotada e avisa quando o acesso foi recusado', async () => {
    handler = (_r, _b, res) => json(res, 403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
    await expect(yt().publish(acct(), input(), auth)).rejects.toThrow(/cota diária/);
    handler = (_r, _b, res) => json(res, 401, {});
    await expect(yt().publish(acct(), input(), auth)).rejects.toThrow(/Reconecte/);
    expect(rejected).toBe(1);
  });

  it('falha clara se não der para ler o vídeo ou se o YouTube não devolver o id', async () => {
    handler = (req, _b, res) => (req.url === '/nao-existe.mp4' ? res.writeHead(404).end() : json(res, 200, {}, { location: `${base}/session/s1` }));
    await expect(yt().publish(acct(), input({ media: { ...input().media, url: `${base}/nao-existe.mp4` } }), auth)).rejects.toThrow(/ler o vídeo/);
    await expect(yt().publish(acct(), input(), auth)).rejects.toThrow(/Falha durante o envio|não confirmou/); // sessão que não aceita o arquivo
  });

  it('valida título, tamanhos, caracteres proibidos e formato', () => {
    const v = yt().validate;
    expect(v(input({ title: '' }))).toEqual(expect.arrayContaining([expect.stringMatching(/título é obrigatório/)]));
    expect(v(input({ title: 'x'.repeat(101) }))).toEqual(expect.arrayContaining([expect.stringMatching(/100 caracteres/)]));
    expect(v(input({ title: 'a <b>' }))).toEqual(expect.arrayContaining([expect.stringMatching(/< e >/)]));
    expect(v(input({ media: { ...input().media, mimeType: 'video/avi' } }))).toEqual(expect.arrayContaining([expect.stringMatching(/formato/)]));
    expect(v(input())).toEqual([]);
  });
});

describe('Facebook', () => {
  const fb = () => facebookPublisher({ graph: `${base}/graph` });

  it('envia a URL do vídeo (file_url) com o token da Página no corpo, nunca na URL', async () => {
    handler = (_r, _b, res) => json(res, 200, { id: '987' });
    const r = await fb().publish(acct(), input(), auth);
    expect(r).toMatchObject({ platformPostId: '987', url: 'https://www.facebook.com/PAGE1/videos/987' });
    const call = log[0]!;
    expect(call.path).toBe('/graph/PAGE1/videos');
    expect(call.path).not.toContain('TOKEN-1');
    const form = Object.fromEntries(new URLSearchParams(call.body.toString()));
    expect(form).toMatchObject({ file_url: `${base}/media.mp4`, published: 'true', access_token: 'TOKEN-1', title: 'Meu vídeo' });
    expect(form.description).toBe('Meu vídeo\n\nDescrição #teste');
  });

  it('privado vira não publicado, com aviso', async () => {
    handler = (_r, _b, res) => json(res, 200, { id: '1' });
    const r = await fb().publish(acct(), input({ visibility: 'PRIVATE' }), auth);
    expect(Object.fromEntries(new URLSearchParams(log[0]!.body.toString())).published).toBe('false');
    expect(r.note).toMatch(/não publicado/);
  });

  it('código 190 pede reconexão; outros códigos viram mensagens claras sem vazar token', async () => {
    handler = (_r, _b, res) => json(res, 400, { error: { code: 190, message: 'Invalid token TOKEN-1' } });
    const e = await fb().publish(acct(), input(), auth).catch((x) => x);
    expect(e).toBeInstanceOf(PublishError);
    expect(e.message).toMatch(/Reconecte/);
    expect(e.message).not.toContain('TOKEN-1');
    expect(rejected).toBe(1);
    handler = (_r, _b, res) => json(res, 400, { error: { code: 200 } });
    await expect(fb().publish(acct(), input(), auth)).rejects.toThrow(/administrador/);
    handler = (_r, _b, res) => json(res, 400, { error: { code: 999 } });
    await expect(fb().publish(acct(), input(), auth)).rejects.toThrow(/código 999/);
  });

  it('exige o id da Página e valida formato', async () => {
    await expect(fb().publish(acct({ platformAccountId: null }), input(), auth)).rejects.toThrow(/Reconecte/);
    expect(fb().validate(input({ media: { ...input().media, mimeType: 'video/webm' } }))[0]).toMatch(/MP4 ou MOV/);
  });
});

describe('TikTok', () => {
  const tt = (o = {}) => tiktokPublisher({ base: `${base}/tt`, chunkSize: 10_000, pollIntervalMs: 1, pollAttempts: 3, ...o });
  const direct = ['user.info.basic', 'video.upload', 'video.publish'];
  let statuses: string[];
  let privacyOptions: string[];
  let initBodies: any[];
  const server_ = () => {
    handler = (req, body, res) => {
      const p = req.url!;
      if (p === '/tt/v2/post/publish/creator_info/query/') return void json(res, 200, { data: { privacy_level_options: privacyOptions, max_video_post_duration_sec: 600 }, error: { code: 'ok' } });
      if (p === '/tt/v2/post/publish/video/init/' || p === '/tt/v2/post/publish/inbox/video/init/') { initBodies.push({ path: p, ...JSON.parse(body.toString()) }); return void json(res, 200, { data: { publish_id: 'PUB1', upload_url: `${base}/upload/u1` }, error: { code: 'ok' } }); }
      if (p === '/upload/u1') return void res.writeHead(body.length && req.headers['content-range']!.endsWith(`-24999/25000`) ? 201 : 206).end();
      if (p === '/tt/v2/post/publish/status/fetch/') return void json(res, 200, { data: { status: statuses.shift() ?? 'PROCESSING_UPLOAD', publicaly_available_post_id: ['7000001'] }, error: { code: 'ok' } });
      res.writeHead(404).end();
    };
  };
  beforeEach(() => { statuses = ['PROCESSING_UPLOAD', 'PUBLISH_COMPLETE']; privacyOptions = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY']; initBodies = []; server_(); });

  it('posta direto: divide em pedaços com Content-Range correto e o vídeo chega igual', async () => {
    const r = await tt().publish(acct({ scopes: direct }), input(), auth);
    expect(r).toEqual({ platformPostId: '7000001', note: undefined });
    expect(initBodies[0]).toMatchObject({
      path: '/tt/v2/post/publish/video/init/',
      post_info: { title: 'Meu vídeo\n\nDescrição #teste', privacy_level: 'PUBLIC_TO_EVERYONE' },
      source_info: { source: 'FILE_UPLOAD', video_size: 25000, chunk_size: 10000, total_chunk_count: 2 },
    });
    const puts = log.filter((l) => l.path === '/upload/u1');
    expect(puts.map((p) => p.headers['content-range'])).toEqual(['bytes 0-9999/25000', 'bytes 10000-24999/25000']); // o último absorve o resto
    expect(Buffer.concat(puts.map((p) => p.body)).equals(VIDEO)).toBe(true);
    expect(log.find((l) => l.path.includes('init'))!.headers.authorization).toBe('Bearer TOKEN-1');
  });

  it('vídeo pequeno vai em um pedaço só', async () => {
    await tt({ chunkSize: 100_000 }).publish(acct({ scopes: direct }), input(), auth);
    expect(initBodies[0].source_info).toMatchObject({ chunk_size: 25000, total_chunk_count: 1 });
    expect(log.filter((l) => l.path === '/upload/u1')[0]!.headers['content-range']).toBe('bytes 0-24999/25000');
  });

  it('app sem auditoria: reduz a visibilidade para a permitida e avisa; privado pedido vira SELF_ONLY', async () => {
    privacyOptions = ['SELF_ONLY'];
    const r = await tt().publish(acct({ scopes: direct }), input(), auth);
    expect(initBodies[0].post_info.privacy_level).toBe('SELF_ONLY');
    expect(r.note).toMatch(/só permitiu a visibilidade "SELF_ONLY"/);
    privacyOptions = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY']; statuses = ['PUBLISH_COMPLETE'];
    await tt().publish(acct({ scopes: direct }), input({ visibility: 'PRIVATE' }), auth);
    expect(initBodies[1].post_info.privacy_level).toBe('SELF_ONLY');
  });

  it('só com video.upload envia como rascunho (caixa de entrada)', async () => {
    statuses = ['SEND_TO_USER_INBOX'];
    const r = await tt().publish(acct({ scopes: ['user.info.basic', 'video.upload'] }), input(), auth);
    expect(initBodies[0].path).toBe('/tt/v2/post/publish/inbox/video/init/');
    expect(initBodies[0].post_info).toBeUndefined();
    expect(r.note).toMatch(/rascunho/);
    expect(log.some((l) => l.path.includes('creator_info'))).toBe(false);
  });

  it('sem permissão de vídeo, falha com orientação (sem chamar o TikTok)', async () => {
    await expect(tt().publish(acct({ scopes: ['user.info.basic'] }), input(), auth)).rejects.toThrow(/sem permissão de vídeo/);
    expect(log).toHaveLength(0);
  });

  it('falha de processamento, código de erro conhecido e token recusado', async () => {
    statuses = ['FAILED'];
    await expect(tt().publish(acct({ scopes: direct }), input(), auth)).rejects.toThrow(/falhou ao processar/);
    handler = (_r, _b, res) => json(res, 200, { error: { code: 'spam_risk_too_many_posts' } });
    await expect(tt().publish(acct({ scopes: direct }), input(), auth)).rejects.toThrow(/limitou o número de posts/);
    handler = (_r, _b, res) => json(res, 401, { error: { code: 'access_token_invalid', message: 'TOKEN-1' } });
    const e = await tt().publish(acct({ scopes: direct }), input(), auth).catch((x) => x);
    expect(e.message).toMatch(/Reconecte/);
    expect(e.message).not.toContain('TOKEN-1');
    expect(rejected).toBe(1);
  });

  it('se o TikTok demora a processar, devolve o publish_id com aviso em vez de falhar', async () => {
    statuses = [];
    const r = await tt().publish(acct({ scopes: direct }), input(), auth);
    expect(r.platformPostId).toBe('PUB1');
    expect(r.note).toMatch(/ainda está processando/);
  });

  it('valida legenda, formato e duração máxima do perfil', async () => {
    expect(tt().validate(input({ description: 'x'.repeat(2300) }))[0]).toMatch(/2200/);
    expect(tt().validate(input({ media: { ...input().media, mimeType: 'video/avi' } }))[0]).toMatch(/MP4, MOV ou WebM/);
    await expect(tt().publish(acct({ scopes: direct }), input({ media: { ...input().media, durationSec: 9999 } }), auth)).rejects.toThrow(/passa do máximo de 600s/);
  });
});
