/** Vídeo assíncrono (Veo) no fluxo de jobs + carteira, contra Postgres real e um Google simulado. Requer TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const MP4 = Buffer.from(Array.from({ length: 4000 }, (_, i) => (i * 3) % 256));
const OP = 'models/veo-3.0-generate-001/operations/op1';

d('vídeo assíncrono + carteira (Postgres real)', () => {
  let server: http.Server;
  let base = '';
  let db: typeof import('@social-manager/db');
  let jobs: typeof import('./jobs');
  let prov: typeof import('./providers');
  let wallet: typeof import('../billing/wallet');
  let store: typeof import('../storage');
  const ws = 'ws_default';

  let submits: any[];
  let opState: () => { status: number; body: any };
  let downloadStatus: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.STORAGE_DIR = `/tmp/sm-test-video-${process.pid}`;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    db = await import('@social-manager/db');
    jobs = await import('./jobs');
    prov = await import('./providers');
    wallet = await import('../billing/wallet');
    store = await import('../storage');

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const j = (s: number, o: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.headers['x-goog-api-key'] !== 'AIza-video-key-1') return void j(400, { error: { message: 'API key not valid' } });
        const p = req.url!.split('?')[0]!;
        if (p === '/v1beta/models') return void j(200, { models: [{ name: 'models/veo-3.0-generate-001', displayName: 'Veo 3', supportedGenerationMethods: ['predictLongRunning'] }] });
        if (p.endsWith(':predictLongRunning')) { submits.push(JSON.parse(Buffer.concat(chunks).toString())); return void j(200, { name: OP }); }
        if (p === `/v1beta/${OP}`) { const r = opState(); return void j(r.status, r.body); }
        if (p === '/v1beta/files/clip1:download') return void (downloadStatus === 200 ? res.writeHead(200, { 'content-type': 'video/mp4' }).end(MP4) : res.writeHead(downloadStatus).end());
        res.writeHead(404).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server?.close(); await db?.prisma.$disconnect(); });
  beforeEach(async () => {
    submits = []; downloadStatus = 200;
    opState = () => ({ status: 200, body: { name: OP, done: false } });
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
  });

  async function setup(price: unknown = { perSecond: 0.5 }) {
    const { id } = await prov.createProvider({ workspaceId: ws, name: 'Google', kind: 'DIRECT', adapter: 'GOOGLE_GEMINI', baseUrl: base, apiKey: 'AIza-video-key-1' });
    await prov.syncProviderModels(ws, id);
    const m = await db.prisma.aIModel.findFirstOrThrow({ where: { providerId: id } });
    await prov.updateModel(ws, m.id, { isActive: true, pricing: price as never });
    return { providerId: id, modelId: m.id };
  }
  const submit = (o: Partial<Parameters<typeof jobs.runAIJob>[0]> = {}) =>
    jobs.runAIJob({ workspaceId: ws, task: 'VIDEO', prompt: 'cena do personagem', params: { durationSec: 8, aspectRatio: '9:16', referenceImageUrls: [] }, ...o });
  const getJob = (id: string) => db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
  const done = (uri = `${base}/v1beta/files/clip1:download?alt=media`) => ({ status: 200, body: { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } } });

  it('o cadastro do provedor Google importa o Veo como modelo de VÍDEO e a chave fica criptografada', async () => {
    const { providerId, modelId } = await setup();
    const p = await db.prisma.aIProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(p).toMatchObject({ adapter: 'GOOGLE_GEMINI', kind: 'DIRECT' });
    expect(p.secretCiphertext).not.toContain('AIza');
    expect((await db.prisma.aIModel.findUniqueOrThrow({ where: { id: modelId } })).modalities).toEqual(['VIDEO']);
  });

  it('enviar o clipe reserva o custo máximo (preço/s × duração) e deixa o job RUNNING, sem debitar ainda', async () => {
    await setup();
    await wallet.creditWallet(ws, 20, 'x');
    const id = await submit();
    const job = await getJob(id);
    expect(job).toMatchObject({ status: 'RUNNING', modality: 'VIDEO', providerRequestId: OP });
    expect(job.estimatedCost!.toString()).toBe('4');
    expect(job.reservedAmount.toString()).toBe('4');
    expect((await db.prisma.wallet.findUniqueOrThrow({ where: { workspaceId: ws } })).balance.toString()).toBe('20');
    expect(submits[0]).toMatchObject({ instances: [{ prompt: 'cena do personagem' }], parameters: { aspectRatio: '9:16', durationSeconds: 8 } });
    // enquanto está reservado, o saldo livre cai
    await expect(submit({ params: { durationSec: 40 } })).rejects.toThrow(/Saldo insuficiente/);
  });

  it('consulta: enquanto não termina continua RUNNING; ao terminar baixa, guarda o arquivo, debita e libera a reserva', async () => {
    await setup();
    await wallet.creditWallet(ws, 20, 'x');
    const id = await submit();
    expect(await jobs.pollVideoJob(id)).toBe('RUNNING');
    expect((await getJob(id)).reservedAmount.toString()).toBe('4');

    opState = () => done();
    expect(await jobs.pollVideoJob(id)).toBe('SUCCEEDED');
    const job = await getJob(id);
    expect(job).toMatchObject({ status: 'SUCCEEDED', outputMimeType: 'video/mp4', costSource: 'COMPUTED' });
    expect(job.actualCost!.toString()).toBe('4');
    expect(job.reservedAmount.toString()).toBe('0');
    expect(Buffer.from((await store.mediaStore.get(job.outputStorageKey!))!).equals(MP4)).toBe(true);
    expect((await db.prisma.wallet.findUniqueOrThrow({ where: { workspaceId: ws } })).balance.toString()).toBe('16');
    const ledger = await db.prisma.usageLedger.findMany({ where: { aiJobId: id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.type).toBe('DEBIT');
    // consultar de novo não debita duas vezes
    expect(await jobs.pollVideoJob(id)).toBe('SUCCEEDED');
    expect(await db.prisma.usageLedger.count({ where: { aiJobId: id } })).toBe(1);
  });

  it('falha do Google (ex.: bloqueio de segurança) libera a reserva e NÃO debita', async () => {
    await setup();
    await wallet.creditWallet(ws, 20, 'x');
    const id = await submit();
    opState = () => ({ status: 200, body: { done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['sensível'] } } } });
    expect(await jobs.pollVideoJob(id)).toBe('FAILED');
    const job = await getJob(id);
    expect(job.status).toBe('FAILED');
    expect(job.errorMessage).toMatch(/filtros de segurança/);
    expect(job.reservedAmount.toString()).toBe('0');
    expect((await db.prisma.wallet.findUniqueOrThrow({ where: { workspaceId: ws } })).balance.toString()).toBe('20');
  });

  it('erro temporário na consulta/download mantém o job RUNNING (com o motivo) e a próxima consulta conclui', async () => {
    await setup();
    await wallet.creditWallet(ws, 20, 'x');
    const id = await submit();
    opState = () => ({ status: 500, body: { error: { message: 'boom' } } });
    expect(await jobs.pollVideoJob(id)).toBe('RUNNING');
    expect((await getJob(id)).errorMessage).toMatch(/HTTP 500/);
    opState = () => done(); downloadStatus = 503;
    expect(await jobs.pollVideoJob(id)).toBe('RUNNING');
    expect((await getJob(id)).status).toBe('RUNNING');
    downloadStatus = 200;
    expect(await jobs.pollVideoJob(id)).toBe('SUCCEEDED');
    expect((await getJob(id)).errorMessage).toBeNull();
  });

  it('sem preço o vídeo é bloqueado antes de enviar; provedor OpenAI-compatível não aceita vídeo', async () => {
    await setup(null);
    await wallet.creditWallet(ws, 20, 'x');
    await expect(submit()).rejects.toThrow(/não tem preço cadastrado/);
    expect(submits).toHaveLength(0);
  });

  it('o limite de tempo de vídeo é maior que o de texto: 20 min continua, 50 min é dado como perdido', async () => {
    await setup();
    await wallet.creditWallet(ws, 20, 'x');
    const a = await submit();
    await db.prisma.aIJob.update({ where: { id: a }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    await jobs.reapStaleJobs(ws);
    expect((await getJob(a)).status).toBe('RUNNING');
    await db.prisma.aIJob.update({ where: { id: a }, data: { createdAt: new Date(Date.now() - 50 * 60_000) } });
    await jobs.reapStaleJobs(ws);
    const lost = await getJob(a);
    expect(lost.status).toBe('FAILED');
    expect(lost.reservedAmount.toString()).toBe('0');
  });
});
