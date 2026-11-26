import Decimal from 'decimal.js';
import { prisma, type VideoProject, type VideoProjectStatus, type VideoScene } from '@social-manager/db';
import { isSupported } from '../ai/adapters';
import { pollVideoJob, runAIJob } from '../ai/jobs';
import { estimateCost, parsePricing } from '../ai/pricing';
import { planRoute, RoutingError } from '../ai/routing';
import { TASK_LABEL } from '../ai/types';
import { dec, readSpend } from '../billing/wallet';
import { assertOwnBlobUrl } from '../blobUrl';
import { UserError } from '../errors';
import { storeOutput } from '../outputs';
import { mediaStore } from '../storage';
import { fitImage, renderFinal } from './render';
import {
  NEGATIVE_PROMPT, allowedClipSeconds, copyPrompt, maxStudioSeconds, parseCopy, parsePlan, planDurations, planPrompt, sceneVideoPrompt, thumbPrompt, type CharacterInfo,
} from './prompts';

const ACTIVE: VideoProjectStatus[] = ['QUEUED', 'PLANNING', 'GENERATING', 'RENDERING'];
const LOCK_MS = 6 * 60_000;
const MAX_IN_FLIGHT = 3;
const THUMB_MAX_BYTES = 2 * 1024 * 1024;

export interface PipelineDeps {
  sleep?: (ms: number) => Promise<void>;
  render?: typeof renderFinal;
}
const wait = (d: PipelineDeps) => d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

type Full = VideoProject & {
  scenes: VideoScene[];
  character: { name: string; description: string; referenceUrls: string[] } | null;
  group: { clientId: string | null; defaultFormat: string } | null;
};

const load = (id: string): Promise<Full> =>
  prisma.videoProject.findUniqueOrThrow({
    where: { id },
    include: { scenes: { orderBy: { index: 'asc' } }, character: { select: { name: true, description: true, referenceUrls: true } }, group: { select: { clientId: true, defaultFormat: true } } },
  });

const charInfo = (p: Full): CharacterInfo | null => (p.character ? { name: p.character.name, description: p.character.description, referenceUrls: p.character.referenceUrls } : null);
const jobTag = (p: { id: string }) => `studio:${p.id}`;

// ── Estimativa e criação ──────────────────────────────────

async function routeEstimate(workspaceId: string, task: Parameters<typeof planRoute>[0]['task'], request: Parameters<typeof planRoute>[0]['request']) {
  const [providers, models, pref] = await Promise.all([
    prisma.aIProvider.findMany({ where: { workspaceId } }),
    prisma.aIModel.findMany({ where: { provider: { workspaceId } } }),
    prisma.aITaskPreference.findUnique({ where: { workspaceId_task: { workspaceId, task } } }),
  ]);
  try {
    const plan = planRoute({ task, request, providers, models: models.map((m) => ({ ...m, pricing: parsePricing(m.pricing) })), preference: pref, isSupported });
    return { model: plan.entries[0]!.model.displayName, estimate: plan.entries[0]!.estimate };
  } catch (e) {
    if (e instanceof RoutingError) throw new UserError(`Estúdio: ${e.message}`);
    throw e;
  }
}

/** Custo máximo do vídeo inteiro (roteiro + textos + thumbnail + clipes) e checagem de saldo ANTES de gastar qualquer coisa. */
export async function estimateProject(workspaceId: string, o: { idea: string; durations: number[] }) {
  const totalSeconds = o.durations.reduce((a, b) => a + b, 0);
  const items = [
    { task: 'SCRIPT' as const, req: { prompt: o.idea, params: { maxOutputTokens: 2000 } } },
    { task: 'CAPTION' as const, req: { prompt: o.idea, params: { maxOutputTokens: 1000 } } },
    { task: 'IMAGE' as const, req: { prompt: o.idea, params: { imageCount: 1 } } },
    { task: 'VIDEO' as const, req: { prompt: o.idea, params: { durationSec: totalSeconds } } },
  ];
  const wallet = await prisma.wallet.findUniqueOrThrow({ where: { workspaceId } });
  let total = new Decimal(0);
  const parts: Record<string, { model: string; cost: Decimal | null }> = {};
  for (const it of items) {
    const r = await routeEstimate(workspaceId, it.task, it.req);
    if (r.estimate === null && !wallet.allowUnpricedModels) {
      throw new UserError(`O modelo "${r.model}" (${TASK_LABEL[it.task]}) não tem preço cadastrado. Informe o preço em Central de IA → Modelos para o custo poder ser controlado.`);
    }
    parts[it.task] = { model: r.model, cost: r.estimate };
    total = total.add(r.estimate ?? 0);
  }
  const spend = await readSpend(prisma, workspaceId);
  const free = dec(wallet.balance).sub(spend.reserved);
  return { total, free, parts, totalSeconds };
}

export interface CreateProjectInput {
  workspaceId: string;
  prompt: string;
  targetSeconds: number;
  groupId?: string | null;
  /** undefined = usa o personagem fixo do grupo; null = sem personagem; id = este personagem. */
  characterId?: string | null;
  aspect?: '9:16' | '16:9';
}

export async function createVideoProject(input: CreateProjectInput) {
  const prompt = input.prompt.trim();
  if (prompt.length < 5) throw new UserError('Escreva a ideia do vídeo (pelo menos 5 caracteres).');
  if (prompt.length > 4000) throw new UserError('A ideia passa de 4000 caracteres.');
  const max = maxStudioSeconds();
  const target = Math.round(input.targetSeconds);
  if (!Number.isFinite(target) || target < 3 || target > max) throw new UserError(`A duração deve ficar entre 3 e ${max} segundos.`);

  const group = input.groupId ? await prisma.accountGroup.findFirst({ where: { id: input.groupId, workspaceId: input.workspaceId } }) : null;
  if (input.groupId && !group) throw new UserError('Grupo não encontrado.');
  const characterId = input.characterId === undefined ? (group?.characterId ?? null) : input.characterId;
  if (characterId && !(await prisma.character.count({ where: { id: characterId, workspaceId: input.workspaceId } }))) throw new UserError('Personagem não encontrado.');
  const aspect = input.aspect ?? (group?.defaultFormat === 'HORIZONTAL_16_9' ? '16:9' : '9:16');

  const durations = planDurations(target, allowedClipSeconds());
  const est = await estimateProject(input.workspaceId, { idea: prompt, durations });
  if (est.free.lt(est.total)) {
    throw new UserError(`Saldo insuficiente para este vídeo: custo máximo estimado US$ ${est.total.toFixed(2)} (${durations.length} cena(s), ${est.totalSeconds}s de vídeo); disponível US$ ${est.free.toFixed(2)}. Registre crédito em Custos.`);
  }

  const p = await prisma.videoProject.create({
    data: {
      workspaceId: input.workspaceId, groupId: group?.id ?? null, characterId, prompt, targetSeconds: target, aspect,
      status: 'QUEUED', step: 'Na fila', estimatedCost: est.total.toString(),
      scenes: { create: durations.map((seconds, index) => ({ index, seconds, prompt: '' })) },
    },
    select: { id: true },
  });
  return { id: p.id, estimatedCost: est.total, durations };
}

// ── Avanço ────────────────────────────────────────────────

const setStep = (id: string, step: string, status?: VideoProjectStatus) => prisma.videoProject.update({ where: { id }, data: { step, ...(status ? { status } : {}) } });
const fail = (id: string, message: string) => prisma.videoProject.update({ where: { id }, data: { status: 'FAILED', step: 'Falhou', error: message.slice(0, 500) } });

/**
 * Avança o projeto o máximo possível até `deadlineMs`. Seguro para chamar de vários lugares ao mesmo tempo (cron, navegador):
 * só um executa por vez (trava com validade). Cada chamada é idempotente e retoma de onde parou.
 */
export async function advanceProject(projectId: string, opts: { deadlineMs?: number; deps?: PipelineDeps } = {}): Promise<Full> {
  const now = new Date();
  const claimed = await prisma.videoProject.updateMany({
    where: { id: projectId, status: { in: ACTIVE }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  if (claimed.count === 0) return load(projectId);

  const deps = opts.deps ?? {};
  const deadline = Date.now() + (opts.deadlineMs ?? 25_000);
  try {
    await runSteps(projectId, deadline, deps);
  } catch (e) {
    const known = e instanceof UserError;
    if (!known) console.error('[studio]', projectId, e);
    await fail(projectId, known ? (e as Error).message : 'Falha interna no estúdio. Veja os logs do servidor.');
  } finally {
    await prisma.videoProject.update({ where: { id: projectId }, data: { lockedUntil: null } }).catch(() => {});
  }
  return load(projectId);
}

async function runSteps(projectId: string, deadline: number, deps: PipelineDeps) {
  for (;;) {
    let p = await load(projectId);
    if (!ACTIVE.includes(p.status)) return;

    if (p.scenes.some((s) => !s.prompt)) { await planStep(p); continue; }
    if (!p.thumbJobId && !p.thumbError && p.titles.length) await thumbStep(p);

    p = await load(projectId);
    const inflight = p.scenes.filter((s) => s.status === 'SUBMITTED').length;
    let slots = MAX_IN_FLIGHT - inflight;
    for (const s of p.scenes.filter((x) => x.status === 'PENDING')) {
      if (slots-- <= 0) break;
      await submitScene(p, s);
    }

    p = await load(projectId);
    for (const s of p.scenes.filter((x) => x.status === 'SUBMITTED')) await pollScene(s);

    p = await load(projectId);
    const sc = p.scenes;
    if (sc.every((s) => s.status === 'DONE')) { await renderStep(p, deps); return; }
    if (!sc.some((s) => s.status === 'PENDING' || s.status === 'SUBMITTED') && sc.some((s) => s.status === 'FAILED')) {
      await fail(projectId, `${sc.filter((s) => s.status === 'FAILED').length} cena(s) falharam. Veja o motivo em cada cena e use "Tentar de novo".`);
      return;
    }
    const left = deadline - Date.now();
    if (left <= 2000) return;
    await setStep(projectId, `Gerando as cenas (${sc.filter((s) => s.status === 'DONE').length}/${sc.length} prontas)…`, 'GENERATING');
    await wait(deps)(Math.min(Number(process.env.STUDIO_POLL_INTERVAL_MS) > 0 ? Number(process.env.STUDIO_POLL_INTERVAL_MS) : 10_000, left - 1000));
  }
}

/** Pede o JSON à IA; se vier inválido, tenta mais uma vez dizendo o que faltou. */
async function askJson<T>(p: Full, task: 'SCRIPT' | 'CAPTION', req: { system: string; prompt: string }, parse: (text: string) => T): Promise<T> {
  let prompt = req.prompt;
  let lastError = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const id = await runAIJob({
      workspaceId: p.workspaceId, clientId: p.group?.clientId ?? null, requestedBy: jobTag(p), task, prompt,
      params: { system: req.system, maxOutputTokens: 2000, temperature: 0.8 },
    });
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id } });
    if (job.status !== 'SUCCEEDED' || !job.outputText) throw new UserError(`${TASK_LABEL[task]}: ${job.errorMessage ?? 'a IA não respondeu'}`);
    try {
      return parse(job.outputText);
    } catch (e) {
      lastError = (e as Error).message;
      prompt = `${req.prompt}\n\nA resposta anterior foi recusada (${lastError}). Refaça seguindo EXATAMENTE o formato JSON pedido.`;
    }
  }
  throw new UserError(`${TASK_LABEL[task]}: a IA não devolveu o formato esperado (${lastError}). Tente de novo ou escolha outro modelo em Central de IA.`);
}

async function planStep(p: Full) {
  await setStep(p.id, 'Escrevendo o roteiro das cenas…', 'PLANNING');
  const character = charInfo(p);
  const durations = p.scenes.map((s) => s.seconds);
  const visuals = await askJson(p, 'SCRIPT', planPrompt({ idea: p.prompt, character, durations, aspect: p.aspect }), (t) => parsePlan(t, durations.length));
  await setStep(p.id, 'Escrevendo título, descrição, tags e hashtags…');
  const copy = await askJson(p, 'CAPTION', copyPrompt({ idea: p.prompt, character, scenes: visuals }), parseCopy);

  await prisma.$transaction([
    ...p.scenes.map((s, i) => prisma.videoScene.update({ where: { id: s.id }, data: { prompt: sceneVideoPrompt({ visual: visuals[i]!, character, index: i, total: durations.length }) } })),
    prisma.videoProject.update({
      where: { id: p.id },
      data: { titles: copy.titles, selectedTitle: copy.titles[0], description: copy.description, tags: copy.tags, hashtags: copy.hashtags, status: 'GENERATING', step: 'Gerando as cenas…' },
    }),
  ]);
}

export async function makeThumbnail(p: Full) {
  const title = p.selectedTitle ?? p.titles[0] ?? p.prompt.slice(0, 80);
  const firstScene = p.scenes[0]?.prompt.split('\n').slice(-2, -1)[0] ?? p.prompt;
  try {
    const id = await runAIJob({
      workspaceId: p.workspaceId, clientId: p.group?.clientId ?? null, requestedBy: jobTag(p), task: 'IMAGE',
      prompt: thumbPrompt({ title, character: charInfo(p), scene: firstScene, aspect: p.aspect }),
      params: { imageSize: p.aspect === '9:16' ? '1024x1536' : '1536x1024', referenceImageUrls: p.character?.referenceUrls ?? [] },
    });
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id } });
    if (job.status !== 'SUCCEEDED') throw new UserError(job.errorMessage ?? 'a IA de imagem falhou');
    let url = job.outputUrl ?? `/api/ai/jobs/${job.id}/output`;
    // O YouTube só aceita thumbnail de até 2 MB e a imagem da IA costuma passar disso: comprime aqui (onde há FFmpeg),
    // assim a publicação nunca depende dele.
    try {
      const original = job.outputUrl ? new Uint8Array(await (await fetch(assertOwnBlobUrl(job.outputUrl, 'thumbnail'), { signal: AbortSignal.timeout(30_000), redirect: 'error' })).arrayBuffer()) : job.outputStorageKey ? await mediaStore.get(job.outputStorageKey) : null;
      if (original) {
        const fit = await fitImage(original, THUMB_MAX_BYTES);
        if (fit && fit.bytes !== original) {
          const stored = await storeOutput({ key: `studio/${p.workspaceId}/${p.id}-thumb.jpg`, bytes: fit.bytes, mime: fit.mime });
          url = stored.url ?? url;
        }
      }
    } catch (e) {
      console.error('[studio-thumb-fit]', p.id, e); // mantém a original: o YouTube avisará se não couber
    }
    await prisma.videoProject.update({ where: { id: p.id }, data: { thumbJobId: job.id, thumbUrl: url, thumbError: null } });
  } catch (e) {
    // a thumbnail não é essencial: o vídeo segue, e dá para regenerar depois
    await prisma.videoProject.update({ where: { id: p.id }, data: { thumbError: (e instanceof UserError ? e.message : 'Falha ao gerar a thumbnail.').slice(0, 300) } });
  }
}
const thumbStep = (p: Full) => makeThumbnail(p);

async function submitScene(p: Full, s: VideoScene) {
  try {
    const jobId = await runAIJob({
      workspaceId: p.workspaceId, clientId: p.group?.clientId ?? null, requestedBy: jobTag(p), task: 'VIDEO', prompt: s.prompt,
      params: { durationSec: s.seconds, aspectRatio: p.aspect, negativePrompt: NEGATIVE_PROMPT, referenceImageUrls: p.character?.referenceUrls.slice(0, 1) ?? [] },
    });
    const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status === 'FAILED') throw new UserError(job.errorMessage ?? 'o envio da cena falhou');
    await prisma.videoScene.update({ where: { id: s.id }, data: { status: 'SUBMITTED', aiJobId: jobId, error: null, attempts: { increment: 1 } } });
  } catch (e) {
    await prisma.videoScene.update({ where: { id: s.id }, data: { status: 'FAILED', error: (e instanceof UserError ? e.message : 'Falha ao enviar a cena.').slice(0, 400), attempts: { increment: 1 } } });
  }
}

async function pollScene(s: VideoScene) {
  if (!s.aiJobId) { await prisma.videoScene.update({ where: { id: s.id }, data: { status: 'FAILED', error: 'Cena sem job de vídeo.' } }); return; }
  const state = await pollVideoJob(s.aiJobId);
  if (state === 'RUNNING') return;
  const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: s.aiJobId } });
  if (state === 'SUCCEEDED') {
    const clipUrl = job.outputUrl ?? (job.outputStorageKey ? `local:${job.outputStorageKey}` : null);
    await prisma.videoScene.update({ where: { id: s.id }, data: clipUrl ? { status: 'DONE', clipUrl, error: null } : { status: 'FAILED', error: 'O clipe foi gerado mas não foi guardado.' } });
  } else {
    await prisma.videoScene.update({ where: { id: s.id }, data: { status: 'FAILED', error: (job.errorMessage ?? 'A cena falhou.').slice(0, 400) } });
  }
}

async function readClip(url: string): Promise<Uint8Array> {
  if (url.startsWith('local:')) {
    const b = await mediaStore.get(url.slice(6));
    if (!b) throw new UserError('Um clipe sumiu do armazenamento. Gere a cena de novo.');
    return b;
  }
  assertOwnBlobUrl(url, 'clipe');
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: 'error' }).catch((e: Error) => { throw new UserError(`Não foi possível baixar um clipe: ${e.message}`); });
  if (!res.ok) throw new UserError(`Não foi possível baixar um clipe (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function renderStep(p: Full, deps: PipelineDeps) {
  await setStep(p.id, 'Montando o vídeo final…', 'RENDERING');
  try {
    const clips = await Promise.all(p.scenes.map((s) => readClip(s.clipUrl!)));
    const out = await (deps.render ?? renderFinal)({ clips, targetSeconds: p.targetSeconds });
    const stored = await storeOutput({ key: `studio/${p.workspaceId}/${p.id}.mp4`, bytes: out.bytes, mime: 'video/mp4' });
    const title = (p.selectedTitle ?? p.titles[0] ?? 'video').replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 80) || 'video';
    const media = await prisma.mediaAsset.create({
      data: {
        workspaceId: p.workspaceId, name: `${title}.mp4`, storageKey: stored.url ? new URL(stored.url).pathname.replace(/^\//, '') : stored.storageKey!, url: stored.url ?? null,
        mimeType: 'video/mp4', sizeBytes: BigInt(out.bytes.length), width: out.width || null, height: out.height || null, durationSec: out.seconds || p.targetSeconds,
        format: p.aspect === '9:16' ? 'VERTICAL_9_16' : 'HORIZONTAL_16_9',
      },
    });
    await prisma.videoProject.update({
      where: { id: p.id },
      data: { status: 'READY', step: 'Pronto', error: out.note ?? null, finalUrl: stored.url ?? `/api/studio/projects/${p.id}/final`, finalMediaId: media.id },
    });
  } catch (e) {
    await fail(p.id, e instanceof UserError ? e.message : `Não foi possível montar o vídeo: ${(e as Error).message}`);
  }
}

// ── Ações do usuário ──────────────────────────────────────

/** Tenta de novo o que falhou: cenas com falha voltam para a fila; sem cena falha, refaz a montagem. */
export async function resumeProject(workspaceId: string, id: string) {
  const p = await prisma.videoProject.findFirst({ where: { id, workspaceId }, include: { scenes: true } });
  if (!p) throw new UserError('Projeto não encontrado.');
  if (p.status !== 'FAILED') throw new UserError('Só dá para retomar um projeto que falhou.');
  const failed = p.scenes.filter((s) => s.status === 'FAILED');
  if (failed.length) await prisma.videoScene.updateMany({ where: { id: { in: failed.map((s) => s.id) } }, data: { status: 'PENDING', error: null } });
  const unplanned = p.scenes.some((s) => !s.prompt);
  await prisma.videoProject.update({ where: { id }, data: { status: unplanned ? 'QUEUED' : failed.length ? 'GENERATING' : 'RENDERING', error: null, step: 'Retomando…', lockedUntil: null } });
}

/** Cancela: para de criar cenas novas. Cenas já enviadas ao Google continuam e são cobradas por ele. */
export async function cancelProject(workspaceId: string, id: string) {
  const r = await prisma.videoProject.updateMany({ where: { id, workspaceId, status: { in: ACTIVE } }, data: { status: 'CANCELLED', step: 'Cancelado' } });
  if (r.count === 0) throw new UserError('Só dá para cancelar um projeto em andamento.');
}

export async function updateProjectCopy(workspaceId: string, id: string, c: { selectedTitle: string; description: string; tags: string; hashtags: string }) {
  const clean = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  const title = clean(c.selectedTitle).slice(0, 100);
  if (!title) throw new UserError('O título não pode ficar vazio.');
  const tags = [...new Set(c.tags.split(',').map((t) => clean(t).replace(/^#+/, '')).filter(Boolean))];
  if (tags.join(',').length > 480) throw new UserError('As tags passam de 500 caracteres (limite do YouTube).');
  const hashtags = [...new Set(c.hashtags.split(/[\s,]+/).map((h) => '#' + clean(h).replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1))].slice(0, 15);
  const r = await prisma.videoProject.updateMany({ where: { id, workspaceId }, data: { selectedTitle: title, description: c.description.replace(/[<>]/g, '').trim().slice(0, 1500), tags: tags.slice(0, 20), hashtags } });
  if (r.count === 0) throw new UserError('Projeto não encontrado.');
}

/** Gera outra thumbnail (cobra de novo). Funciona também com o vídeo pronto. */
export async function regenerateThumbnail(workspaceId: string, id: string) {
  const owned = await prisma.videoProject.count({ where: { id, workspaceId } });
  if (!owned) throw new UserError('Projeto não encontrado.');
  await prisma.videoProject.update({ where: { id }, data: { thumbJobId: null, thumbError: null } });
  await makeThumbnail(await load(id));
  const p = await prisma.videoProject.findUniqueOrThrow({ where: { id } });
  if (p.thumbError) throw new UserError(`Thumbnail: ${p.thumbError}`);
}

export async function getProject(workspaceId: string, id: string) {
  const p = await prisma.videoProject.findFirst({ where: { id, workspaceId }, include: { scenes: { orderBy: { index: 'asc' } }, character: true, group: { select: { id: true, name: true } } } });
  if (!p) return null;
  const cost = await prisma.aIJob.aggregate({ where: { workspaceId, requestedBy: jobTag(p) }, _sum: { actualCost: true, reservedAmount: true } });
  return { ...p, spent: dec(cost._sum.actualCost), reserved: dec(cost._sum.reservedAmount) };
}

export function listProjects(workspaceId: string) {
  return prisma.videoProject.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 30, include: { group: { select: { name: true } }, character: { select: { name: true } }, scenes: { select: { status: true } } } });
}

/** Avança todos os projetos em andamento (usado pelo agendador). */
export async function advanceAll(opts: { deadlineMs?: number; deps?: PipelineDeps } = {}) {
  const end = Date.now() + (opts.deadlineMs ?? 230_000);
  const now = new Date();
  const projects = await prisma.videoProject.findMany({
    where: { status: { in: ACTIVE }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    orderBy: { createdAt: 'asc' }, take: 10, select: { id: true },
  });
  const results = await Promise.all(projects.map((p) => advanceProject(p.id, { deadlineMs: Math.max(5000, end - Date.now()), deps: opts.deps }).then((r) => r.status).catch(() => 'FAILED' as const)));
  return { projects: projects.length, ready: results.filter((s) => s === 'READY').length, failed: results.filter((s) => s === 'FAILED').length };
}

/** Preço do modelo de vídeo que seria usado (para mostrar a estimativa no formulário). null se não houver modelo/preço. */
export async function previewVideoPrice(workspaceId: string): Promise<{ model: string; perSecond: number } | null> {
  try {
    const r = await routeEstimate(workspaceId, 'VIDEO', { prompt: 'x', params: { durationSec: 1 } });
    return r.estimate ? { model: r.model, perSecond: Number(r.estimate.toString()) } : null;
  } catch {
    return null;
  }
}
