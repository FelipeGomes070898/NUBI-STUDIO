import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError } from '../types';
import { GoogleGeminiAdapter } from './google-gemini';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const MP4 = Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 5) % 256));
const OP = 'models/veo-3.0-generate-001/operations/abc123';

let server: http.Server;
let base = '';
let log: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: any }>;
let handler: (req: http.IncomingMessage, body: any, res: http.ServerResponse) => void;
const json = (res: http.ServerResponse, s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      let body: any = raw; try { body = raw ? JSON.parse(raw) : null; } catch { /* binário */ }
      log.push({ method: req.method!, path: req.url!, headers: req.headers, body });
      if (req.url === '/ref.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
      if (req.url === '/ref.txt') return void res.writeHead(200, { 'content-type': 'text/plain' }).end('x');
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());
beforeEach(() => { log = []; handler = (_r, _b, res) => res.writeHead(404).end('{}'); });
const gem = () => new GoogleGeminiAdapter({ baseUrl: `${base}/`, apiKey: 'AIza-test-key-123' });

describe('GoogleGeminiAdapter', () => {
  it('usa a chave só no header e declara o que executa (texto e vídeo, não imagem)', async () => {
    handler = (_r, _b, res) => json(res, 200, { models: [] });
    expect((await gem().healthCheck()).ok).toBe(true);
    expect(log[0]!.headers['x-goog-api-key']).toBe('AIza-test-key-123');
    expect(log[0]!.path).not.toContain('AIza');
    expect(gem().supports).toEqual({ TEXT: true, IMAGE: false, AUDIO: false, VIDEO: true });
    await expect(gem().generateImage({ model: 'm', prompt: 'p' })).rejects.toThrow(/não gera imagens/);
  });

  it('lista modelos: Veo vira VÍDEO, Gemini vira TEXTO; ignora embeddings/imagem; segue paginação', async () => {
    handler = (req, _b, res) => {
      if (req.url!.includes('pageToken=P2')) return json(res, 200, { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] }] });
      json(res, 200, { models: [
        { name: 'models/veo-3.0-generate-001', displayName: 'Veo 3', supportedGenerationMethods: ['predictLongRunning'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      ], nextPageToken: 'P2' });
    };
    const m = await gem().listModels();
    expect(m.map((x) => `${x.providerModelId}:${x.modalities}`)).toEqual(['veo-3.0-generate-001:VIDEO', 'gemini-2.5-pro:TEXT']);
    expect(m[0]!.displayName).toBe('Veo 3');
  });

  it('gera texto lendo o uso; resposta bloqueada vira erro claro', async () => {
    handler = (_r, _b, res) => json(res, 200, { candidates: [{ content: { parts: [{ text: 'Olá ' }, { text: 'mundo' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
    const r = await gem().generateText({ model: 'gemini-2.5-pro', prompt: 'oi', system: 'sys', maxOutputTokens: 50 });
    expect(r).toEqual({ text: 'Olá mundo', inputTokens: 7, outputTokens: 3 });
    expect(log[0]!.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(log[0]!.body).toMatchObject({ systemInstruction: { parts: [{ text: 'sys' }] }, contents: [{ role: 'user', parts: [{ text: 'oi' }] }], generationConfig: { maxOutputTokens: 50 } });
    handler = (_r, _b, res) => json(res, 200, { candidates: [{ finishReason: 'SAFETY' }] });
    await expect(gem().generateText({ model: 'm', prompt: 'p' })).rejects.toThrow(/filtros/);
  });

  it('envia o clipe com a imagem do personagem, proporção e duração', async () => {
    handler = (_r, _b, res) => json(res, 200, { name: OP });
    const r = await gem().submitVideo({ model: 'veo-3.0-generate-001', prompt: 'cena 1', aspectRatio: '9:16', durationSec: 8, referenceImageUrls: [`${base}/ref.png`] });
    expect(r).toEqual({ operationId: OP });
    const call = log.find((l) => l.path.includes('predictLongRunning'))!;
    expect(call.path).toBe('/v1beta/models/veo-3.0-generate-001:predictLongRunning');
    expect(call.body.instances[0].prompt).toBe('cena 1');
    expect(call.body.instances[0].image).toEqual({ bytesBase64Encoded: PNG.toString('base64'), mimeType: 'image/png' });
    expect(call.body.parameters).toMatchObject({ aspectRatio: '9:16', durationSeconds: 8 });
  });

  it('sem referência não manda imagem; referência inválida ou operação malformada são recusadas', async () => {
    handler = (_r, _b, res) => json(res, 200, { name: OP });
    await gem().submitVideo({ model: 'v', prompt: 'p' });
    expect(log[0]!.body.instances[0].image).toBeUndefined();
    expect(log[0]!.body.parameters.aspectRatio).toBe('9:16');
    await expect(gem().submitVideo({ model: 'v', prompt: 'p', referenceImageUrls: [`${base}/ref.txt`] })).rejects.toThrow(/PNG, JPG ou WebP/);
    handler = (_r, _b, res) => json(res, 200, { name: '../../etc/passwd' });
    await expect(gem().submitVideo({ model: 'v', prompt: 'p' })).rejects.toThrow(/identificador/);
    await expect(gem().pollVideo('../../x')).rejects.toThrow(/inválido/);
  });

  it('consulta: em andamento, pronto (uri), erro do Google e bloqueio de segurança', async () => {
    handler = (_r, _b, res) => json(res, 200, { name: OP, done: false });
    expect(await gem().pollVideo(OP)).toEqual({ done: false });
    expect(log[0]!.path).toBe(`/v1beta/${OP}`);
    handler = (_r, _b, res) => json(res, 200, { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${base}/v1beta/files/x:download?alt=media` } }] } } });
    expect(await gem().pollVideo(OP)).toEqual({ done: true, videoRef: `${base}/v1beta/files/x:download?alt=media` });
    handler = (_r, _b, res) => json(res, 200, { done: true, error: { code: 13, message: 'Internal error  occurred' } });
    expect((await gem().pollVideo(OP)).error).toBe('O Google recusou o vídeo: Internal error occurred');
    handler = (_r, _b, res) => json(res, 200, { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['conteúdo sensível'] } } });
    expect((await gem().pollVideo(OP)).error).toMatch(/filtros de segurança: conteúdo sensível/);
  });

  it('baixa o vídeo com a chave (mesmo host) e segue redirecionamento; recusa host de fora', async () => {
    handler = (req, _b, res) => {
      if (req.url!.startsWith('/v1beta/files/x')) return void res.writeHead(302, { location: '/storage/final.mp4' }).end();
      if (req.url === '/storage/final.mp4') return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(MP4);
      if (req.url!.startsWith('/v1beta/files/evil')) return void res.writeHead(302, { location: 'http://evil.test/steal' }).end();
      res.writeHead(404).end();
    };
    const bytes = await gem().downloadVideo(`${base}/v1beta/files/x:download?alt=media`);
    expect(Buffer.from(bytes).equals(MP4)).toBe(true);
    expect(log[0]!.headers['x-goog-api-key']).toBe('AIza-test-key-123');
    await expect(gem().downloadVideo(`${base}/v1beta/files/evil:download`)).rejects.toThrow(/fora dos seus domínios/);
    await expect(gem().downloadVideo('https://evil.example.com/x.mp4')).rejects.toThrow(/fora do Google/);
    expect(log.some((l) => l.path === '/steal')).toBe(false);
  });

  it('erros HTTP viram mensagens seguras sem a chave; 429 repete uma vez', async () => {
    handler = (_r, _b, res) => json(res, 400, { error: { message: 'API key not valid. AIza-test-key-123' } });
    const e = await gem().generateText({ model: 'm', prompt: 'p' }).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/chave de API inválida/);
    let n = 0;
    handler = (_r, _b, res) => (++n < 2 ? json(res, 429, { error: { message: 'slow' } }) : json(res, 200, { name: OP }));
    expect((await gem().submitVideo({ model: 'v', prompt: 'p' })).operationId).toBe(OP);
    expect(n).toBe(2);
    handler = (_r, _b, res) => json(res, 403, { error: { message: 'billing' } });
    await expect(gem().submitVideo({ model: 'v', prompt: 'p' })).rejects.toThrow(/faturamento/);
  });
});
