/**
 * Integração com Postgres REAL + gateway falso (servidor HTTP local no padrão OpenAI).
 * Roda quando TEST_DATABASE_URL está definido (banco já migrado). Ex.:
 *   TEST_DATABASE_URL=postgresql://socialmanager:socialmanager@localhost:5432/socialmanager_test pnpm test
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('AI jobs + carteira (Postgres real)', () => {
  let server: http.Server;
  let gwUrl = '';
  let calls: Array<{ path: string; body: any }> = [];
  let failNext: number | null = null;
  let usage = { prompt_tokens: 100, completion_tokens: 50 };

  // imports dinâmicos: DATABASE_URL precisa estar definido antes de instanciar o PrismaClient
  let db: typeof import('@social-manager/db');
  let jobs: typeof import('./jobs');
  let prov: typeof import('./providers');
  let wallet: typeof import('../billing/wallet');
  let ws = '';

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.STORAGE_DIR = `/tmp/sm-test-storage-${process.pid}`;
    db = await import('@social-manager/db');
    jobs = await import('./jobs');
    prov = await import('./providers');
    wallet = await import('../billing/wallet');

    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : null;
        calls.push({ path: req.url!, body });
        if (req.headers.authorization !== 'Bearer sk-fake-key-9999') return void res.writeHead(401).end('{"error":{"message":"no"}}');
        if (failNext) { const s = failNext; failNext = null; return void res.writeHead(s, { 'content-type': 'application/json' }).end('{"error":{"message":"boom"}}'); }
        const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url === '/v1/models')
          return json({ data: [{ id: 'txt-cheap' }, { id: 'txt-pricey' }, { id: 'gpt-image-1' }, { id: 'tts-1' }, { id: 'veo-3' }] });
        if (req.url === '/v1/chat/completions') return json({ id: 'r1', choices: [{ message: { content: `eco:${body.model}` } }], usage });
        if (req.url === '/v1/images/generations') return json({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] });
        if (req.url === '/v1/audio/speech') return void res.writeHead(200, { 'content-type': 'audio/mpeg' }).end(Buffer.from([1, 2, 3, 4]));
        res.writeHead(404).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    gwUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    server?.close();
    await db?.prisma.$disconnect();
  });

  beforeEach(async () => {
    calls = [];
    failNext = null;
    usage = { prompt_tokens: 100, completion_tokens: 50 };
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    const w = await db.prisma.workspace.create({ data: { id: 'ws_default', name: 't', wallet: { create: {} } } });
    ws = w.id;
  });

  /** Provedor + modelos ativos com preço. */
  async function setup() {
    const { id } = await prov.createProvider({ workspaceId: ws, name: 'GW', kind: 'UNIFIED', baseUrl: gwUrl, apiKey: 'sk-fake-key-9999' });
    const sync = await prov.syncProviderModels(ws, id);
    const models = await db.prisma.aIModel.findMany({ where: { providerId: id } });
    const by = (n: string) => models.find((m) => m.providerModelId === n)!;
    await prov.updateModel(ws, by('txt-cheap').id, { isActive: true, pricing: { inputPerMTok: 1, outputPerMTok: 2 } });
    await prov.updateModel(ws, by('txt-pricey').id, { isActive: true, pricing: { inputPerMTok: 10, outputPerMTok: 20 } });
    await prov.updateModel(ws, by('gpt-image-1').id, { isActive: true, pricing: { perImage: 0.04 } });
    await prov.updateModel(ws, by('tts-1').id, { isActive: true, pricing: { perMChar: 15 } });
    await prov.updateModel(ws, by('veo-3').id, { isActive: true, pricing: { perSecond: 0.5 } });
    return { providerId: id, by, sync };
  }

  const wal = () => db.prisma.wallet.findUniqueOrThrow({ where: { workspaceId: ws } });

  it('cadastro: chave criptografada no banco, nunca em claro; sync importa modelos desativados', async () => {
    const { providerId, sync } = await setup();
    const p = await db.prisma.aIProvider.findUniqueOrThrow({ where: { id: providerId } });
    expect(p.secretCiphertext).not.toContain('fake-key');
    expect(p.secretHint).toBe('••••9999');
    expect(p.isPrimary).toBe(true);
    expect(sync).toEqual({ total: 5, created: 5, updated: 0 });
    // re-sync não sobrescreve edições do usuário
    const again = await prov.syncProviderModels(ws, providerId);
    expect(again).toEqual({ total: 5, created: 0, updated: 5 });
    const cheap = await db.prisma.aIModel.findFirstOrThrow({ where: { providerId, providerModelId: 'txt-cheap' } });
    expect(cheap.isActive).toBe(true);
    expect(cheap.pricingSource).toBe('MANUAL');
  });

  it('chave inválida: teste de conexão falha e registra o motivo', async () => {
    const { id } = await prov.createProvider({ workspaceId: ws, name: 'ruim', kind: 'DIRECT', baseUrl: gwUrl, apiKey: 'sk-wrong-key-0000' });
    const r = await prov.testProvider(ws, id);
    expect(r.ok).toBe(false);
    const p = await db.prisma.aIProvider.findUniqueOrThrow({ where: { id } });
    expect(p.lastTestOk).toBe(false);
    expect(p.lastTestError).toMatch(/chave inválida/);
  });

  it('texto AUTO: escolhe o mais barato, debita o custo REAL (uso) e libera a reserva', async () => {
    await setup();
    await wallet.creditWallet(ws, 5, 'recarga');
    const id = await jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'Crie um roteiro', params: { maxOutputTokens: 1000 } });
    const job = await db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.providerModelId).toBe('txt-cheap');
    expect(job.selectionMode).toBe('AUTO');
    expect(job.outputText).toBe('eco:txt-cheap');
    // (100*1 + 50*2)/1e6 = 0.0002
    expect(job.actualCost!.toString()).toBe('0.0002');
    expect(job.costSource).toBe('COMPUTED');
    expect(job.reservedAmount.toString()).toBe('0');
    expect(job.estimatedCost!.gt(job.actualCost!)).toBe(true);
    expect((await wal()).balance.toString()).toBe('4.9998');
    const ledger = await db.prisma.usageLedger.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((l) => l.type)).toEqual(['CREDIT', 'DEBIT']);
    expect(ledger[1]!.aiJobId).toBe(id);
    expect(ledger[1]!.balanceAfter.toString()).toBe('4.9998');
    expect(calls.find((c) => c.path.endsWith('/chat/completions'))!.body.max_tokens).toBe(1000);
  });

  it('seleção manual na geração vence a automática', async () => {
    const { by } = await setup();
    await wallet.creditWallet(ws, 5, 'x');
    const id = await jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'p', requestedModelId: by('txt-pricey').id });
    const job = await db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
    expect(job.providerModelId).toBe('txt-pricey');
    expect(job.selectionMode).toBe('MANUAL');
  });

  it('preferência da tarefa: MANUAL fixa o modelo; AUTO com aprovados respeita a ordem', async () => {
    const { by } = await setup();
    await wallet.creditWallet(ws, 5, 'x');
    await prov.saveTaskPreference(ws, { task: 'CAPTION', mode: 'MANUAL', modelId: by('txt-pricey').id, fallbackModelIds: [] });
    const a = await jobs.runAIJob({ workspaceId: ws, task: 'CAPTION', prompt: 'p' });
    expect((await db.prisma.aIJob.findUniqueOrThrow({ where: { id: a } })).providerModelId).toBe('txt-pricey');
    await expect(prov.saveTaskPreference(ws, { task: 'IMAGE', mode: 'AUTO', modelId: by('txt-cheap').id, fallbackModelIds: [] })).rejects.toThrow(/IMAGE/);
  });

  it('sem saldo: bloqueia ANTES de chamar o provedor e não cria cobrança', async () => {
    await setup();
    await expect(jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'p' })).rejects.toThrow(/Saldo insuficiente/);
    expect(calls.filter((c) => c.path.includes('chat'))).toHaveLength(0);
    expect(await db.prisma.aIJob.count()).toBe(0);
  });

  it('orçamento do cliente: bloqueia quando excede e libera outro cliente / sem cliente', async () => {
    await setup();
    await wallet.creditWallet(ws, 50, 'x');
    const acme = await db.prisma.client.create({ data: { workspaceId: ws, name: 'ACME', monthlyBudget: '0.05' } });
    const livre = await db.prisma.client.create({ data: { workspaceId: ws, name: 'Livre' } });
    // imagem custa 0.04 por geração: a 1ª cabe (0.04 ≤ 0.05), a 2ª não (0.08 > 0.05)
    await jobs.runAIJob({ workspaceId: ws, clientId: acme.id, task: 'IMAGE', prompt: 'gato' });
    await expect(jobs.runAIJob({ workspaceId: ws, clientId: acme.id, task: 'IMAGE', prompt: 'gato 2' })).rejects.toThrow(/Orçamento mensal do cliente "ACME"/);
    await jobs.runAIJob({ workspaceId: ws, clientId: livre.id, task: 'IMAGE', prompt: 'cachorro' });
    await jobs.runAIJob({ workspaceId: ws, task: 'IMAGE', prompt: 'sem cliente' });
    const fin = await wallet.getFinanceOverview(ws);
    expect(fin.clients.find((c) => c.name === 'ACME')!.monthSpent.toString()).toBe('0.04');
    expect(fin.unassignedSpent.toString()).toBe('0.04');
    expect(fin.balance.toString()).toBe('49.88');
  });

  it('limite mensal global bloqueia mesmo com saldo', async () => {
    await setup();
    await wallet.creditWallet(ws, 50, 'x');
    await wallet.updateWalletSettings(ws, { monthlyLimit: 0.05, allowUnpricedModels: false });
    await jobs.runAIJob({ workspaceId: ws, task: 'IMAGE', prompt: 'a' });
    await expect(jobs.runAIJob({ workspaceId: ws, task: 'IMAGE', prompt: 'b' })).rejects.toThrow(/Limite mensal da carteira/);
  });

  it('falha do provedor: job FAILED, reserva liberada, nenhum débito', async () => {
    await setup();
    await wallet.creditWallet(ws, 5, 'x');
    failNext = 500;
    const id = await jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'p' });
    const job = await db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('FAILED');
    expect(job.errorMessage).toMatch(/HTTP 500/);
    expect(job.reservedAmount.toString()).toBe('0');
    expect((await wal()).balance.toString()).toBe('5');
    expect(await db.prisma.usageLedger.count({ where: { type: 'DEBIT' } })).toBe(0);
  });

  it('concorrência: reservas simultâneas não ultrapassam o saldo', async () => {
    await setup();
    // 3 imagens de 0.04 → saldo 0.09 só comporta 2
    await wallet.creditWallet(ws, 0.09, 'x');
    const results = await Promise.allSettled(Array.from({ length: 3 }, (_, i) => jobs.submitAIJob({ workspaceId: ws, task: 'IMAGE', prompt: `i${i}` })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const reserved = await db.prisma.aIJob.aggregate({ _sum: { reservedAmount: true } });
    expect(reserved._sum.reservedAmount!.toString()).toBe('0.08');
  });

  it('imagem: salva o arquivo e debita; áudio idem; vídeo é recusado com motivo claro', async () => {
    const { by } = await setup();
    await wallet.creditWallet(ws, 5, 'x');
    const img = await jobs.runAIJob({ workspaceId: ws, task: 'IMAGE', prompt: 'um gato' });
    const j = await db.prisma.aIJob.findUniqueOrThrow({ where: { id: img } });
    expect(j.outputStorageKey).toBe(`ai/${ws}/${img}.png`);
    const { mediaStore } = await import('../storage');
    expect(Buffer.from((await mediaStore.get(j.outputStorageKey!))!).toString()).toBe('PNGDATA');
    expect(j.actualCost!.toString()).toBe('0.04');

    const au = await jobs.runAIJob({ workspaceId: ws, task: 'NARRATION', prompt: 'a'.repeat(2000) });
    const a = await db.prisma.aIJob.findUniqueOrThrow({ where: { id: au } });
    expect(a.status).toBe('SUCCEEDED');
    expect(a.actualCost!.toString()).toBe('0.03');

    await expect(jobs.runAIJob({ workspaceId: ws, task: 'VIDEO', prompt: 'x', requestedModelId: by('veo-3').id })).rejects.toThrow(/suporte pendente/);
  });

  it('modelo sem preço é bloqueado por padrão e liberado por configuração', async () => {
    const { by } = await setup();
    await wallet.creditWallet(ws, 5, 'x');
    await db.prisma.aIModel.update({ where: { id: by('txt-cheap').id }, data: { pricing: db.Prisma.DbNull } });
    await expect(jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'p', requestedModelId: by('txt-cheap').id })).rejects.toThrow(/preço/);
    await wallet.updateWalletSettings(ws, { monthlyLimit: null, allowUnpricedModels: true });
    const id = await jobs.runAIJob({ workspaceId: ws, task: 'SCRIPT', prompt: 'p', requestedModelId: by('txt-cheap').id });
    const job = await db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('SUCCEEDED');
    expect(job.actualCost).toBeNull(); // sem preço e sem custo informado → não inventa valor
  });

  it('job travado é encerrado pelo reaper e a reserva é solta; settle não debita job já encerrado', async () => {
    await setup();
    await wallet.creditWallet(ws, 5, 'x');
    const id = await jobs.submitAIJob({ workspaceId: ws, task: 'IMAGE', prompt: 'travou' });
    await db.prisma.aIJob.update({ where: { id }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    await jobs.reapStaleJobs(ws);
    const job = await db.prisma.aIJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('FAILED');
    expect(job.reservedAmount.toString()).toBe('0');
    await jobs.executeAIJob(id); // não está mais QUEUED → ignora
    expect(calls.filter((c) => c.path.includes('images'))).toHaveLength(0);
  });

  it('carteira: ajuste exige motivo; crédito inválido é recusado', async () => {
    await expect(wallet.creditWallet(ws, 0, 'x')).rejects.toThrow(/maior que zero/);
    await expect(wallet.adjustWallet(ws, -1, '  ')).rejects.toThrow(/motivo/);
    await wallet.creditWallet(ws, 10, 'x');
    await wallet.adjustWallet(ws, -2.5, 'correção');
    expect((await wal()).balance.toString()).toBe('7.5');
  });

  it('URL base: exige https (http só em localhost) e sem credenciais', () => {
    expect(() => prov.normalizeBaseUrl('http://exemplo.com/v1')).toThrow(/https/);
    expect(() => prov.normalizeBaseUrl('https://u:p@exemplo.com')).toThrow(/usuário/);
    expect(prov.normalizeBaseUrl('https://exemplo.com/v1/')).toBe('https://exemplo.com/v1');
    expect(prov.normalizeBaseUrl('http://localhost:4000/v1')).toBe('http://localhost:4000/v1');
  });
});
