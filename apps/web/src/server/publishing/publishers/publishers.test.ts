import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PublishError, type PublishAccount, type PublishAuth, type PublishInput } from '../types';
import { facebookPublisher } from './facebook';
import { instagramPublisher } from './instagram';
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

const input = (o: Partial<PublishInput> = {}): PublishInput => ({ kind: 'POST', tags: [],
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

describe('Facebook — story', () => {
  const fb = () => facebookPublisher({ graph: `${base}/graph` });
  const storyInput = () => input({ kind: 'STORY' });

  it('inicia, manda a URL do vídeo para a Meta buscar (rupload) e finaliza', async () => {
    handler = (req, body, res) => {
      if (req.url === '/graph/PAGE1/video_stories') {
        const f = Object.fromEntries(new URLSearchParams(body.toString()));
        return f.upload_phase === 'start' ? json(res, 200, { video_id: 'V9', upload_url: `${base}/rupload/V9` }) : json(res, 200, { success: true, post_id: 'POST9' });
      }
      if (req.url === '/rupload/V9') return json(res, 200, { success: true });
      res.writeHead(404).end();
    };
    const r = await fb().publish(acct(), storyInput(), auth);
    expect(r).toMatchObject({ platformPostId: 'POST9' });
    expect(r.note).toMatch(/processar/);
    const up = log.find((l) => l.path === '/rupload/V9')!;
    expect(up.headers.authorization).toBe('OAuth TOKEN-1');
    expect(up.headers.file_url).toBe(`${base}/media.mp4`);
    const fin = Object.fromEntries(new URLSearchParams(log.filter((l) => l.path === '/graph/PAGE1/video_stories')[1]!.body.toString()));
    expect(fin).toMatchObject({ upload_phase: 'finish', video_id: 'V9', access_token: 'TOKEN-1' });
    expect(log.some((l) => l.path.endsWith('/videos'))).toBe(false); // não usa o endpoint de vídeo comum
  });

  it('token recusado pede reconexão; story privado e longo demais são recusados antes de chamar', async () => {
    handler = (_r, _b, res) => json(res, 400, { error: { code: 190 } });
    await expect(fb().publish(acct(), storyInput(), auth)).rejects.toThrow(/Reconecte/);
    expect(rejected).toBe(1);
    expect(fb().validate(input({ kind: 'STORY', visibility: 'PRIVATE' }))[0]).toMatch(/não pode ser privado/);
    expect(fb().validate(input({ kind: 'STORY', media: { ...input().media, durationSec: 300 } }))[0]).toMatch(/120 segundos/);
  });
});

describe('Instagram', () => {
  const ig = (o = {}) => instagramPublisher({ graph: `${base}/graph`, pollIntervalMs: 1, pollAttempts: 4, ...o });
  let statusCodes: string[];
  let mediaBodies: Array<Record<string, string>>;
  beforeEach(() => {
    statusCodes = ['IN_PROGRESS', 'FINISHED']; mediaBodies = [];
    handler = (req, body, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/graph/IG1/media') { mediaBodies.push(Object.fromEntries(new URLSearchParams(body.toString()))); return void json(res, 200, { id: 'CONT1' }); }
      if (u.pathname === '/graph/CONT1') return void json(res, 200, { status_code: statusCodes.shift() ?? 'IN_PROGRESS' });
      if (u.pathname === '/graph/IG1/media_publish') return void json(res, 200, { id: 'MEDIA1' });
      if (u.pathname === '/graph/MEDIA1') return void json(res, 200, { permalink: 'https://www.instagram.com/reel/abc/' });
      res.writeHead(404).end();
    };
  });

  it('post de vídeo vira Reels: cria o contêiner, espera processar e publica', async () => {
    const r = await ig().publish(acct({ platformAccountId: 'IG1' }), input(), auth);
    expect(r).toEqual({ platformPostId: 'MEDIA1', url: 'https://www.instagram.com/reel/abc/' });
    expect(mediaBodies[0]).toMatchObject({ media_type: 'REELS', video_url: `${base}/media.mp4`, caption: 'Meu vídeo\n\nDescrição #teste', share_to_feed: 'true', access_token: 'TOKEN-1' });
    const paths = log.map((l) => `${l.method} ${l.path.split('?')[0]}`);
    expect(paths.indexOf('POST /graph/IG1/media')).toBeLessThan(paths.indexOf('GET /graph/CONT1'));
    expect(paths.indexOf('GET /graph/CONT1')).toBeLessThan(paths.indexOf('POST /graph/IG1/media_publish'));
    expect(log.filter((l) => l.path.startsWith('/graph/CONT1')).length).toBe(2); // IN_PROGRESS → FINISHED
    expect(log.find((l) => l.path === '/graph/IG1/media')!.path).not.toContain('TOKEN-1'); // token no corpo, não na URL
  });

  it('story usa STORIES e não envia legenda', async () => {
    const r = await ig().publish(acct({ platformAccountId: 'IG1' }), input({ kind: 'STORY' }), auth);
    expect(mediaBodies[0]).toMatchObject({ media_type: 'STORIES', video_url: `${base}/media.mp4` });
    expect(mediaBodies[0]!.caption).toBeUndefined();
    expect(mediaBodies[0]!.share_to_feed).toBeUndefined();
    expect(r.url).toBeUndefined();
  });

  it('erro de processamento, demora demais, token inválido e códigos conhecidos viram mensagens claras', async () => {
    statusCodes = ['ERROR'];
    await expect(ig().publish(acct({ platformAccountId: 'IG1' }), input(), auth)).rejects.toThrow(/não conseguiu processar/);
    statusCodes = [];
    await expect(ig().publish(acct({ platformAccountId: 'IG1' }), input(), auth)).rejects.toThrow(/demorou demais/);
    handler = (_r, _b, res) => json(res, 400, { error: { code: 190, message: 'TOKEN-1' } });
    const e = await ig().publish(acct({ platformAccountId: 'IG1' }), input(), auth).catch((x) => x);
    expect(e.message).toMatch(/Reconecte/);
    expect(e.message).not.toContain('TOKEN-1');
    expect(rejected).toBe(1);
    handler = (_r, _b, res) => json(res, 400, { error: { code: 100, error_subcode: 2207026 } });
    await expect(ig().publish(acct({ platformAccountId: 'IG1' }), input(), auth)).rejects.toThrow(/H\.264/);
    await expect(ig().publish(acct({ platformAccountId: null }), input(), auth)).rejects.toThrow(/Reconecte/);
  });

  it('valida: sem privado, MP4/MOV, story até 60s, legenda até 2200', () => {
    expect(ig().validate(input({ visibility: 'PRIVATE' }))[0]).toMatch(/não existe publicação privada/);
    expect(ig().validate(input({ media: { ...input().media, mimeType: 'video/webm' } }))[0]).toMatch(/MP4 ou MOV/);
    expect(ig().validate(input({ kind: 'STORY', media: { ...input().media, durationSec: 61 } }))[0]).toMatch(/até 60 segundos/);
    expect(ig().validate(input({ kind: 'POST', media: { ...input().media, durationSec: 61 } }))).toEqual([]);
    expect(ig().validate(input({ description: 'x'.repeat(2300) }))[0]).toMatch(/2200/);
    expect(ig().validate(input())).toEqual([]);
  });
});

describe('YouTube e TikTok não têm story', () => {
  it('recusam story na validação', () => {
    expect(youtubePublisher().validate(input({ kind: 'STORY' })).join(' ')).toMatch(/YouTube: não tem story/);
    expect(tiktokPublisher().validate(input({ kind: 'STORY' })).join(' ')).toMatch(/TikTok: não tem story/);
  });
});

describe('tags e thumbnail', () => {
  const PNG_BYTES = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const yt = (deps = {}) => youtubePublisher({ uploadBase: `${base}/upload/youtube/v3`, ...deps });
  const ytHandler = (thumbStatus = 200) => (req: http.IncomingMessage, _b: Buffer, res: http.ServerResponse) => {
    if (req.url!.startsWith('/upload/youtube/v3/videos')) return void json(res, 200, {}, { location: `${base}/session/s1` });
    if (req.url === '/session/s1') return void json(res, 200, { id: 'VID1', status: { privacyStatus: 'public' } });
    if (req.url!.startsWith('/upload/youtube/v3/thumbnails/set')) return void json(res, thumbStatus, {});
    if (req.url === '/thumb.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG_BYTES);
    res.writeHead(404).end();
  };

  it('YouTube envia as tags no vídeo e aplica a thumbnail depois do upload', async () => {
    handler = ytHandler();
    const r = await yt().publish(acct(), input({ tags: ['corrida', 'parque infantil'], thumbnailUrl: `${base}/thumb.png` }), auth);
    expect(r.note).toBeUndefined();
    const init = log.find((l) => l.path.startsWith('/upload/youtube/v3/videos'))!;
    expect(JSON.parse(init.body.toString()).snippet.tags).toEqual(['corrida', 'parque infantil']);
    const th = log.find((l) => l.path.startsWith('/upload/youtube/v3/thumbnails/set'))!;
    expect(th.path).toContain('videoId=VID1');
    expect(th.headers['content-type']).toBe('image/png');
    expect(th.headers.authorization).toBe('Bearer TOKEN-1');
    expect(th.body.equals(PNG_BYTES)).toBe(true);
  });

  it('thumbnail grande é comprimida antes de enviar; sem conseguir caber vira aviso, não erro', async () => {
    handler = ytHandler();
    const fitImage = async (b: Uint8Array) => ({ bytes: new Uint8Array([0xff, 0xd8, 1, 2, 3]), mime: 'image/jpeg' });
    await yt({ fitImage }).publish(acct(), input({ thumbnailUrl: `${base}/thumb.png` }), auth);
    const th = log.find((l) => l.path.includes('thumbnails/set'))!;
    expect(th.headers['content-type']).toBe('image/jpeg');
    expect(Array.from(th.body)).toEqual([0xff, 0xd8, 1, 2, 3]);
    log = [];
    const r = await yt({ fitImage: async () => null }).publish(acct(), input({ thumbnailUrl: `${base}/thumb.png` }), auth);
    expect(r.platformPostId).toBe('VID1');
    expect(r.note).toMatch(/não coube nos 2 MB/);
  });

  it('canal sem verificação (403) ou imagem ilegível: o vídeo sai e o aviso explica', async () => {
    handler = ytHandler(403);
    const r = await yt().publish(acct(), input({ thumbnailUrl: `${base}/thumb.png` }), auth);
    expect(r).toMatchObject({ platformPostId: 'VID1' });
    expect(r.note).toMatch(/canal precisa estar verificado/);
    handler = ytHandler();
    const r2 = await yt().publish(acct(), input({ thumbnailUrl: `${base}/nao-existe.png` }), auth);
    expect(r2.platformPostId).toBe('VID1');
    expect(r2.note).toMatch(/não foi possível ler a imagem/);
  });

  it('sem tags nem thumbnail nada extra é enviado; tags longas demais são recusadas na validação', async () => {
    handler = ytHandler();
    await yt().publish(acct(), input(), auth);
    expect(JSON.parse(log.find((l) => l.path.startsWith('/upload/youtube/v3/videos'))!.body.toString()).snippet.tags).toBeUndefined();
    expect(log.some((l) => l.path.includes('thumbnails'))).toBe(false);
    expect(yt().validate(input({ tags: ['x'.repeat(300), 'y'.repeat(300)] }))[0]).toMatch(/tags passam de 500/);
  });

  it('Instagram usa a thumbnail como capa do Reels (cover_url) e não manda capa no story', async () => {
    const mediaBodies: Array<Record<string, string>> = [];
    handler = (req, body, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/graph/IG1/media') { mediaBodies.push(Object.fromEntries(new URLSearchParams(body.toString()))); return void json(res, 200, { id: 'C1' }); }
      if (u.pathname === '/graph/C1') return void json(res, 200, { status_code: 'FINISHED' });
      if (u.pathname === '/graph/IG1/media_publish') return void json(res, 200, { id: 'M1' });
      json(res, 200, {});
    };
    const ig = instagramPublisher({ graph: `${base}/graph`, pollIntervalMs: 1 });
    await ig.publish(acct({ platformAccountId: 'IG1' }), input({ thumbnailUrl: 'https://abc.public.blob.vercel-storage.com/t.png' }), auth);
    await ig.publish(acct({ platformAccountId: 'IG1' }), input({ kind: 'STORY', thumbnailUrl: 'https://abc.public.blob.vercel-storage.com/t.png' }), auth);
    expect(mediaBodies[0]!.cover_url).toBe('https://abc.public.blob.vercel-storage.com/t.png');
    expect(mediaBodies[1]!.cover_url).toBeUndefined();
  });
});
