/** Estúdio de vídeos de ponta a ponta: IA simulada (texto, imagem, Veo) + FFmpeg REAL + Postgres real. Requer TEST_DATABASE_URL. */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const sh = promisify(execFile);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GOOD_COPY = JSON.stringify({ titles: ['A grande corrida do Luciano', 'Luciano e a corrida maluca', 'Corrida no parque'], description: 'O Luciano corre pelo parque.', tags: ['corrida', 'parque'], hashtags: ['corrida', 'luciano'] });

d('estúdio de vídeos (ponta a ponta)', () => {
  let db: typeof import('@social-manager/db');
  let studio: typeof import('./pipeline');
  let prov: typeof import('../ai/providers');
  let wallet: typeof import('../billing/wallet');
  let CLIP: Buffer;
  let oa: http.Server, gm: http.Server;
  let oaBase = '', gmBase = '';
  const ws = 'ws_default';
  const noSleep = { sleep: async () => {} };

  // estado dos servidores simulados
  let chat: Array<{ system: string; user: string }>;
  let planReply: (n: number, attempt: number) => string;
  let copyReply: () => string;
  let imageCalls: Array<{ path: string; ctype: string; hasRef: boolean; prompt: string }>;
  let submits: any[];
  let opPolls: Map<string, number>;
  let opFail: Set<number>; // índice (1-based) do envio cujo resultado será bloqueado pelo filtro de segurança
  let planAttempts: number;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.STORAGE_DIR = `/tmp/sm-test-studio-${process.pid}`;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    db = await import('@social-manager/db');
    studio = await import('./pipeline');
    prov = await import('../ai/providers');
    wallet = await import('../billing/wallet');
    const { ffmpegPath } = await import('./render');
    const dir = await mkdtemp(path.join(tmpdir(), 'clip-'));
    await sh(await ffmpegPath(), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dir, 'c.mp4')]);
    CLIP = await readFile(path.join(dir, 'c.mp4'));
    await rm(dir, { recursive: true, force: true });

    oa = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const j = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.url === '/ref.png') return void res.writeHead(200, { 'content-type': 'image/png' }).end(PNG);
        if (req.headers.authorization !== 'Bearer sk-studio-key-1') return void res.writeHead(401).end('{"error":{"message":"no"}}');
        if (req.url === '/v1/models') return j({ data: [{ id: 'claude-test' }, { id: 'gpt-image-test' }] });
        if (req.url === '/v1/chat/completions') {
          const body = JSON.parse(raw.toString());
          const system = body.messages.find((m: any) => m.role === 'system')?.content ?? '';
          const user = body.messages.find((m: any) => m.role === 'user')?.content ?? '';
          chat.push({ system, user });
          let content: string;
          if (system.includes('roteirista')) { const n = Number(/EXATAMENTE (\d+)/.exec(user)![1]); content = planReply(n, ++planAttempts); } else content = copyReply();
          return j({ id: 'c', choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 100 } });
        }
        if (req.url === '/v1/images/edits' || req.url === '/v1/images/generations') {
          const text = raw.toString('latin1');
          imageCalls.push({ path: req.url, ctype: String(req.headers['content-type']), hasRef: text.includes('ref0.png'), prompt: req.url.endsWith('edits') ? text : JSON.parse(raw.toString()).prompt });
          return j({ data: [{ b64_json: PNG.toString('base64') }] });
        }
        res.writeHead(404).end('{}');
      });
    });
    gm = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const j = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        const p = req.url!.split('?')[0]!;
        if (req.headers['x-goog-api-key'] !== 'AIza-studio-key-1') return void res.writeHead(400).end('{"error":{"message":"API key not valid"}}');
        if (p === '/v1beta/models') return j({ models: [{ name: 'models/veo-3.0-generate-001', displayName: 'Veo 3', supportedGenerationMethods: ['predictLongRunning'] }] });
        if (p.endsWith(':predictLongRunning')) { submits.push(JSON.parse(Buffer.concat(chunks).toString())); return j({ name: `models/veo-3.0-generate-001/operations/op${submits.length}` }); }
        const op = /^\/v1beta\/(models\/veo-3\.0-generate-001\/operations\/op(\d+))$/.exec(p);
        if (op) {
          const n = (opPolls.get(op[1]!) ?? 0) + 1; opPolls.set(op[1]!, n);
          if (n < 2) return j({ name: op[1], done: false });
          if (opFail.has(Number(op[2]))) return j({ done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ['conteúdo sensível'] } } });
          return j({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `http://127.0.0.1:${(gm.address() as AddressInfo).port}/v1beta/files/clip${op[2]}:download?alt=media` } }] } } });
        }
        if (p.startsWith('/v1beta/files/')) return void res.writeHead(200, { 'content-type': 'video/mp4' }).end(CLIP);
        res.writeHead(404).end('{}');
      });
    });
    await Promise.all([new Promise<void>((r) => oa.listen(0, '127.0.0.1', r)), new Promise<void>((r) => gm.listen(0, '127.0.0.1', r))]);
    oaBase = `http://127.0.0.1:${(oa.address() as AddressInfo).port}`;
    gmBase = `http://127.0.0.1:${(gm.address() as AddressInfo).port}`;
  });
  afterAll(async () => { oa?.close(); gm?.close(); await db?.prisma.$disconnect(); });

  let groupId = '';
  let characterId = '';
  beforeEach(async () => {
    chat = []; imageCalls = []; submits = []; opPolls = new Map(); opFail = new Set(); planAttempts = 0;
    planReply = (n) => JSON.stringify({ scenes: Array.from({ length: n }, (_, i) => ({ visual: `scene ${i + 1}: the boy runs through the park, camera tracking` })) });
    copyReply = () => GOOD_COPY;
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
    const a = await prov.createProvider({ workspaceId: ws, name: 'Gateway', kind: 'UNIFIED', baseUrl: `${oaBase}/v1`, apiKey: 'sk-studio-key-1' });
    const b = await prov.createProvider({ workspaceId: ws, name: 'Google', kind: 'DIRECT', adapter: 'GOOGLE_GEMINI', baseUrl: gmBase, apiKey: 'AIza-studio-key-1' });
    await prov.syncProviderModels(ws, a.id); await prov.syncProviderModels(ws, b.id);
    const price = { 'claude-test': { inputPerMTok: 3, outputPerMTok: 15 }, 'gpt-image-test': { perImage: 0.04 }, 'veo-3.0-generate-001': { perSecond: 0.5 } } as Record<string, object>;
    for (const m of await db.prisma.aIModel.findMany()) await prov.updateModel(ws, m.id, { isActive: true, pricing: price[m.providerModelId] as never });
    await wallet.creditWallet(ws, 100, 'x');
    const ch = await db.prisma.character.create({ data: { workspaceId: ws, name: 'Luciano ZEEN', description: 'Menino de 8 anos, cabelo cacheado castanho, camiseta amarela com raio, tênis vermelho', referenceUrls: [`${oaBase}/ref.png`] } });
    characterId = ch.id;
    groupId = (await db.prisma.accountGroup.create({ data: { workspaceId: ws, name: 'Luciano ZEEN', defaultFormat: 'VERTICAL_9_16', characterId: ch.id } })).id;
  });

  const create = (o: Partial<Parameters<typeof studio.createVideoProject>[0]> = {}) => studio.createVideoProject({ workspaceId: ws, prompt: 'o Luciano corre num parque e pula uma poça', targetSeconds: 10, groupId, ...o });
  const run = (id: string, o: Parameters<typeof studio.advanceProject>[1] = {}) => studio.advanceProject(id, { deadlineMs: 60_000, deps: noSleep, ...o });

  it('10 segundos viram 2 cenas (8s + 4s); o personagem do GRUPO entra sozinho; a estimativa cobre o custo', async () => {
    const r = await create();
    expect(r.durations).toEqual([8, 4]);
    expect(r.estimatedCost.gt(6)).toBe(true); // 12s × $0.50 + textos + imagem
    const p = await db.prisma.videoProject.findUniqueOrThrow({ where: { id: r.id }, include: { scenes: { orderBy: { index: 'asc' } } } });
    expect(p).toMatchObject({ status: 'QUEUED', characterId, aspect: '9:16', targetSeconds: 10 });
    expect(p.scenes.map((s) => s.seconds)).toEqual([8, 4]);
    expect(p.scenes.every((s) => s.prompt === '' && s.status === 'PENDING')).toBe(true);
  });

  it('roda tudo: roteiro → textos → thumbnail → clipes → montagem; entrega 10s verticais, com o personagem em tudo', async () => {
    const { id } = await create();
    const p = await run(id);
    expect(p.status).toBe('READY');
    expect(p.error).toBeNull();

    // textos
    expect(p.titles).toHaveLength(3);
    expect(p.selectedTitle).toBe('A grande corrida do Luciano');
    expect(p.description).toBe('O Luciano corre pelo parque.');
    expect(p.tags).toEqual(['corrida', 'parque']);
    expect(p.hashtags).toEqual(['#corrida', '#luciano']);
    expect(chat.find((c) => c.system.includes('roteirista'))!.user).toContain('EXATAMENTE 2 item');

    // personagem fixo: em TODAS as cenas (bloco idêntico), com a imagem de referência, na proporção e duração certas
    const block = 'FIXED CHARACTER "Luciano ZEEN"';
    expect(submits).toHaveLength(2);
    for (const s of submits) {
      expect(s.instances[0].prompt).toContain(block);
      expect(s.instances[0].prompt).toContain('camiseta amarela com raio');
      expect(s.instances[0].image).toEqual({ bytesBase64Encoded: PNG.toString('base64'), mimeType: 'image/png' });
      expect(s.parameters.aspectRatio).toBe('9:16');
      expect(s.parameters.negativePrompt).toMatch(/subtitles/);
    }
    expect(submits.map((s) => s.parameters.durationSeconds).sort()).toEqual([4, 8]);
    expect(submits.some((s) => s.instances[0].prompt.includes('continues directly from the previous scene'))).toBe(true);

    // thumbnail: gerada com a referência do personagem (edits) e o bloco do personagem no prompt
    expect(imageCalls).toHaveLength(1);
    expect(imageCalls[0]).toMatchObject({ path: '/v1/images/edits', hasRef: true });
    expect(imageCalls[0]!.ctype).toMatch(/multipart\/form-data/);
    expect(imageCalls[0]!.prompt).toContain(block);
    expect(imageCalls[0]!.prompt).toContain('A grande corrida do Luciano');
    expect(p.thumbUrl).toMatch(/\/api\/ai\/jobs\/.+\/output$/); // sem Blob (teste): serve pela rota autenticada

    // vídeo final: MediaAsset com 10s verticais
    const media = await db.prisma.mediaAsset.findUniqueOrThrow({ where: { id: p.finalMediaId! } });
    expect(media).toMatchObject({ mimeType: 'video/mp4', format: 'VERTICAL_9_16', width: 720, height: 1280, name: 'A grande corrida do Luciano.mp4' });
    expect(Math.abs(media.durationSec! - 10)).toBeLessThan(0.3);
    expect(p.scenes.every((s) => s.status === 'DONE' && s.clipUrl)).toBe(true);
  });

  it('custo: cada job fica ligado ao projeto, o saldo cai pelo real e nada fica reservado ao final', async () => {
    const { id, estimatedCost } = await create();
    await run(id);
    const got = (await studio.getProject(ws, id))!;
    expect(got.reserved.toString()).toBe('0');
    expect(got.spent.gt(6)).toBe(true);
    expect(got.spent.lte(estimatedCost)).toBe(true); // o real nunca passa do máximo estimado
    const w = await db.prisma.wallet.findUniqueOrThrow({ where: { workspaceId: ws } });
    expect(100 - Number(w.balance)).toBeCloseTo(Number(got.spent), 4);
    const kinds = (await db.prisma.aIJob.findMany({ where: { requestedBy: `studio:${id}` } })).map((j) => j.task).sort();
    expect(kinds).toEqual(['CAPTION', 'IMAGE', 'SCRIPT', 'VIDEO', 'VIDEO']);
  });

  it('o personagem pode ser trocado na hora ou removido, sem mexer no do grupo', async () => {
    const outro = await db.prisma.character.create({ data: { workspaceId: ws, name: 'Outro', description: 'Cachorro caramelo de óculos escuros' } });
    const a = await create({ characterId: outro.id });
    await run(a.id);
    expect(submits[0].instances[0].prompt).toContain('FIXED CHARACTER "Outro"');
    expect(submits[0].instances[0].image).toBeUndefined(); // sem imagem de referência cadastrada
    submits = [];
    const b = await create({ characterId: null });
    await run(b.id);
    expect(submits[0].instances[0].prompt).not.toContain('FIXED CHARACTER');
    expect((await db.prisma.accountGroup.findUniqueOrThrow({ where: { id: groupId } })).characterId).toBe(characterId);
  });

  it('antes de gastar: duração fora do limite, grupo/personagem inexistentes e saldo insuficiente são recusados', async () => {
    await expect(create({ targetSeconds: 2 })).rejects.toThrow(/entre 3 e 120/);
    await expect(create({ targetSeconds: 500 })).rejects.toThrow(/entre 3 e 120/);
    await expect(create({ prompt: 'oi' })).rejects.toThrow(/pelo menos 5/);
    await expect(create({ groupId: 'nao-existe' })).rejects.toThrow(/Grupo não encontrado/);
    await expect(create({ characterId: 'nao-existe' })).rejects.toThrow(/Personagem não encontrado/);
    await wallet.adjustWallet(ws, -95, 'teste: deixa só US$ 5'); // 30s × $0.50 = $15 > $5
    await expect(create({ targetSeconds: 30 })).rejects.toThrow(/Saldo insuficiente.*custo máximo estimado US\$ 1\d\.\d\d/);
    expect(await db.prisma.videoProject.count()).toBe(0); // nada foi criado
    expect(submits).toHaveLength(0);
  }, 20000);

  it('sem preço no modelo de vídeo bloqueia antes de qualquer chamada; sem modelo de vídeo também', async () => {
    const veo = await db.prisma.aIModel.findFirstOrThrow({ where: { providerModelId: 'veo-3.0-generate-001' } });
    await db.prisma.aIModel.update({ where: { id: veo.id }, data: { pricing: db.Prisma.DbNull } });
    await expect(create()).rejects.toThrow(/Veo 3.*não tem preço cadastrado/);
    await db.prisma.aIModel.update({ where: { id: veo.id }, data: { isActive: false } });
    await expect(create()).rejects.toThrow(/Estúdio:.*VIDEO/);
    expect(chat).toHaveLength(0);
    expect(submits).toHaveLength(0);
  });

  it('a IA devolve o roteiro quebrado: tenta mais uma vez; se continuar quebrado, falha com mensagem clara e nada de vídeo é cobrado', async () => {
    planReply = (n, attempt) => (attempt === 1 ? 'Claro! Aqui vai o roteiro sem JSON.' : JSON.stringify({ scenes: Array.from({ length: n }, () => ({ visual: 'the boy runs through the park' })) }));
    const a = await create();
    expect((await run(a.id)).status).toBe('READY');
    expect(planAttempts).toBe(2);
    expect(chat.filter((c) => c.system.includes('roteirista'))[1]!.user).toMatch(/resposta anterior foi recusada/);

    planAttempts = 0; planReply = () => 'sem json nenhum';
    const b = await create();
    const failed = await run(b.id);
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatch(/não devolveu o formato esperado/);
    expect(await db.prisma.aIJob.count({ where: { requestedBy: `studio:${b.id}`, task: 'VIDEO' } })).toBe(0);
  });

  it('uma cena bloqueada pelo filtro do Google: projeto falha dizendo qual; "tentar de novo" refaz só essa cena e conclui; sem cobrança da falha', async () => {
    opFail = new Set([2]);
    const { id } = await create();
    const failed = await run(id);
    expect(failed.status).toBe('FAILED');
    const bad = failed.scenes.filter((s) => s.status === 'FAILED');
    expect(bad).toHaveLength(1);
    expect(bad[0]!.error).toMatch(/filtros de segurança/);
    expect(failed.scenes.filter((s) => s.status === 'DONE')).toHaveLength(1);
    expect((await studio.getProject(ws, id))!.reserved.toString()).toBe('0'); // reserva da cena que falhou foi solta

    opFail = new Set();
    await studio.resumeProject(ws, id);
    const done = await run(id);
    expect(done.status).toBe('READY');
    expect(submits).toHaveLength(3); // 2 + só a cena que falhou
    await expect(studio.resumeProject(ws, id)).rejects.toThrow(/falhou/);
  });

  it('duas execuções ao mesmo tempo (cron + navegador) não duplicam envios nem custo', async () => {
    const { id } = await create();
    await Promise.all([run(id), run(id), run(id)]);
    const p = await run(id);
    expect(p.status).toBe('READY');
    expect(submits).toHaveLength(2); // cada cena enviada uma vez só
    expect(imageCalls).toHaveLength(1);
    expect(chat.filter((c) => c.system.includes('roteirista'))).toHaveLength(1);
  });

  it('a trava vence sozinha: projeto "preso" por processo que caiu é retomado', async () => {
    const { id } = await create();
    await db.prisma.videoProject.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + 5 * 60_000) } });
    expect((await run(id)).status).toBe('QUEUED'); // travado: não mexe
    await db.prisma.videoProject.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await run(id)).status).toBe('READY');
  });

  it('cancelar para o projeto; editar título/descrição/tags/hashtags limpa o texto; thumbnail pode ser refeita', async () => {
    const c = await create();
    await studio.cancelProject(ws, c.id);
    expect((await run(c.id)).status).toBe('CANCELLED');
    expect(submits).toHaveLength(0);
    await expect(studio.cancelProject(ws, c.id)).rejects.toThrow(/em andamento/);

    const { id } = await create();
    await run(id);
    await studio.updateProjectCopy(ws, id, { selectedTitle: '  Novo <b>título</b>  ', description: 'Descrição <x> nova', tags: '#a, b ,, a', hashtags: 'x  #y, z' });
    const p = await db.prisma.videoProject.findUniqueOrThrow({ where: { id } });
    expect(p).toMatchObject({ selectedTitle: 'Novo btítulo/b', description: 'Descrição x nova', tags: ['a', 'b'], hashtags: ['#x', '#y', '#z'] });
    await expect(studio.updateProjectCopy(ws, id, { selectedTitle: ' ', description: '', tags: '', hashtags: '' })).rejects.toThrow(/título/);
    await expect(studio.updateProjectCopy('outro', id, { selectedTitle: 'x', description: '', tags: '', hashtags: '' })).rejects.toThrow(/não encontrado/);

    const before = imageCalls.length;
    await studio.regenerateThumbnail(ws, id);
    expect(imageCalls.length).toBe(before + 1);
    await expect(studio.regenerateThumbnail('outro', id)).rejects.toThrow(/não encontrado/);
  });

  it('o agendador avança todos os projetos em andamento de uma vez', async () => {
    const [a, b] = [await create(), await create({ prompt: 'outro vídeo com o Luciano no mercado' })];
    const stats = await studio.advanceAll({ deadlineMs: 60_000, deps: noSleep });
    expect(stats).toMatchObject({ projects: 2, ready: 2, failed: 0 });
    expect((await db.prisma.videoProject.findMany({ where: { id: { in: [a.id, b.id] } } })).every((p) => p.status === 'READY')).toBe(true);
    expect(await studio.advanceAll({ deps: noSleep })).toMatchObject({ projects: 0 });
  });
});
