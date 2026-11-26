import Decimal from 'decimal.js';
import { prisma, Prisma, type AIJob, type AITask } from '@social-manager/db';
import { checkBudget } from '../billing/budget';
import { dec, lockWallet, postLedger, readSpend } from '../billing/wallet';
import { decryptSecret } from '../crypto';
import { UserError } from '../errors';
import { storeOutput } from '../outputs';
import { createAdapter, isSupported } from './adapters';
import { computeTextCost, maxOutputTokens, parsePricing, usd } from './pricing';
import { planRoute, RoutingError, type RouteEntry } from './routing';
import { ProviderError, TASK_MODALITY, type GenerationParams } from './types';

const STALE_AFTER_MS = 15 * 60 * 1000;
/** Vídeo (Veo) leva minutos e é consultado em outro momento: tolera bem mais antes de ser dado como perdido. */
const STALE_VIDEO_AFTER_MS = 45 * 60 * 1000;
const MAX_PROMPT_CHARS = 20_000;

export interface SubmitInput {
  workspaceId: string;
  clientId?: string | null;
  requestedBy?: string;
  task: AITask;
  prompt: string;
  params?: GenerationParams;
  /** Modelo escolhido manualmente nesta geração. Vazio = usa a preferência da tarefa (manual ou automática). */
  requestedModelId?: string | null;
}

/** Jobs que ficaram QUEUED/RUNNING (processo caiu) soltam a reserva depois de 15 min. */
export async function reapStaleJobs(workspaceId: string) {
  const data = { status: 'FAILED' as const, reservedAmount: 0, completedAt: new Date() };
  await prisma.aIJob.updateMany({
    where: { workspaceId, modality: { not: 'VIDEO' }, status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(Date.now() - STALE_AFTER_MS) } },
    data: { ...data, errorMessage: 'Interrompido: sem resposta por mais de 15 minutos. Confira no painel do provedor se houve cobrança.' },
  });
  await prisma.aIJob.updateMany({
    where: { workspaceId, modality: 'VIDEO', status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lt: new Date(Date.now() - STALE_VIDEO_AFTER_MS) } },
    data: { ...data, errorMessage: 'O vídeo não ficou pronto em 45 minutos. Confira no painel do provedor se houve cobrança.' },
  });
}

/** Roteia, valida orçamento e RESERVA o valor máximo na carteira. Não chama o provedor. */
export async function submitAIJob(input: SubmitInput): Promise<string> {
  const { workspaceId, task } = input;
  const prompt = input.prompt.trim();
  if (!prompt) throw new UserError('Escreva o pedido (prompt).');
  if (prompt.length > MAX_PROMPT_CHARS) throw new UserError(`O pedido passa de ${MAX_PROMPT_CHARS} caracteres.`);
  const params: GenerationParams = { ...input.params };
  if (TASK_MODALITY[task] === 'TEXT') params.maxOutputTokens = maxOutputTokens(params); // o teto estimado = o teto enviado
  if (TASK_MODALITY[task] === 'IMAGE') params.imageCount = 1;

  await reapStaleJobs(workspaceId);

  const [providers, models, pref] = await Promise.all([
    prisma.aIProvider.findMany({ where: { workspaceId } }),
    prisma.aIModel.findMany({ where: { provider: { workspaceId } } }),
    prisma.aITaskPreference.findUnique({ where: { workspaceId_task: { workspaceId, task } } }),
  ]);

  let plan;
  try {
    plan = planRoute({
      task,
      request: { prompt, params },
      providers,
      models: models.map((m) => ({ ...m, pricing: parsePricing(m.pricing) })),
      preference: pref,
      requestedModelId: input.requestedModelId || null,
      isSupported,
    });
  } catch (e) {
    if (e instanceof RoutingError) throw new UserError(e.message);
    throw e;
  }

  return prisma.$transaction(async (tx) => {
    await lockWallet(tx, workspaceId);

    let client: { id: string; name: string; monthlyBudget: Prisma.Decimal | null } | null = null;
    if (input.clientId) {
      client = await tx.client.findFirst({ where: { id: input.clientId, workspaceId }, select: { id: true, name: true, monthlyBudget: true } });
      if (!client) throw new UserError('Cliente não encontrado.');
    }

    const wallet = await tx.wallet.findUniqueOrThrow({ where: { workspaceId } });
    const spend = await readSpend(tx, workspaceId, client?.id);
    const snapshot = {
      balance: dec(wallet.balance),
      reserved: spend.reserved,
      monthlyLimit: wallet.monthlyLimit ? dec(wallet.monthlyLimit) : null,
      monthSpent: spend.monthSpent,
      allowUnpriced: wallet.allowUnpricedModels,
      client: client ? { name: client.name, monthlyBudget: client.monthlyBudget ? dec(client.monthlyBudget) : null, monthSpent: spend.clientMonthSpent, reserved: spend.clientReserved } : null,
    };

    const skipped: string[] = [];
    let chosen: { entry: RouteEntry; reserve: Decimal } | null = null;
    for (const entry of plan.entries) {
      const verdict = checkBudget(entry.estimate, snapshot);
      if (verdict.ok) {
        chosen = { entry, reserve: verdict.reserve };
        break;
      }
      skipped.push(`${entry.model.displayName}: ${verdict.reason}`);
    }
    if (!chosen) throw new UserError(skipped[0]!.replace(/^[^:]+: /, '') + (skipped.length > 1 ? ` (${skipped.length} modelos tentados.)` : ''));

    const { entry, reserve } = chosen;
    const job = await tx.aIJob.create({
      data: {
        workspaceId,
        clientId: client?.id ?? null,
        providerId: entry.provider.id,
        modelId: entry.model.id,
        providerModelId: entry.model.providerModelId,
        requestedBy: input.requestedBy,
        task,
        modality: TASK_MODALITY[task],
        selectionMode: plan.selectionMode,
        routeReason: [plan.reason, ...(skipped.length ? [`Descartados: ${skipped.join(' | ')}`] : [])].join(' ').slice(0, 1000),
        prompt,
        params: params as Prisma.InputJsonValue,
        estimatedCost: entry.estimate?.toString() ?? null,
        reservedAmount: reserve.toString(),
      },
    });
    return job.id;
  });
}

/** Executa um job QUEUED. Idempotente: só quem conseguir mudar QUEUED→RUNNING executa. */
export async function executeAIJob(jobId: string): Promise<void> {
  const claimed = await prisma.aIJob.updateMany({ where: { id: jobId, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } });
  if (claimed.count === 0) return;
  const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: jobId }, include: { provider: true, model: true } });

  try {
    const adapter = createAdapter(job.provider.adapter, { baseUrl: job.provider.baseUrl, apiKey: decryptSecret(job.provider.secretCiphertext) });
    const params = (job.params ?? {}) as GenerationParams;
    const pricing = parsePricing(job.model?.pricing);
    const estimate = job.estimatedCost ? dec(job.estimatedCost) : null;
    const out: Partial<Prisma.AIJobUpdateInput> = {};
    let actual: { cost: Decimal; source: 'REPORTED' | 'COMPUTED' } | null = null;
    const fromReported = (n?: number) => (n !== undefined ? { cost: new Decimal(n), source: 'REPORTED' as const } : null);

    switch (job.modality) {
      case 'TEXT': {
        const r = await adapter.generateText({ model: job.providerModelId, prompt: job.prompt, ...params });
        out.outputText = r.text;
        out.providerRequestId = r.requestId;
        actual = fromReported(r.reportedCost) ?? (pricing && estimate ? { cost: computeTextCost(pricing, r, estimate), source: 'COMPUTED' } : null);
        break;
      }
      case 'IMAGE': {
        const r = await adapter.generateImage({ model: job.providerModelId, prompt: job.prompt, ...params });
        const img = r.images[0]!;
        out.providerRequestId = r.requestId;
        if (img.b64) {
          await saveOutput(`ai/${job.workspaceId}/${job.id}.png`, Buffer.from(img.b64, 'base64'), 'image/png', out);
        } else {
          out.outputUrl = img.url;
        }
        actual = fromReported(r.reportedCost) ?? (estimate ? { cost: estimate, source: 'COMPUTED' } : null);
        break;
      }
      case 'AUDIO': {
        const r = await adapter.generateSpeech({ model: job.providerModelId, input: job.prompt, voice: params.voice });
        await saveOutput(`ai/${job.workspaceId}/${job.id}.mp3`, r.audio, r.mimeType, out);
        out.providerRequestId = r.requestId;
        actual = estimate ? { cost: estimate, source: 'COMPUTED' } : null;
        break;
      }
      case 'VIDEO': {
        if (!adapter.submitVideo) throw new ProviderError('Este provedor não gera vídeo. Use um provedor do tipo Google Gemini (Veo).');
        const op = await adapter.submitVideo({ model: job.providerModelId, prompt: job.prompt, ...params });
        // Vídeo é assíncrono: o job continua RUNNING (com o valor reservado) até pollVideoJob concluir.
        await prisma.aIJob.update({ where: { id: job.id }, data: { providerRequestId: op.operationId } });
        return;
      }
    }

    await settle(job, { status: 'SUCCEEDED', data: out, actual });
  } catch (e) {
    const message = e instanceof ProviderError || e instanceof UserError ? e.message : 'Falha interna ao processar a geração.';
    if (!(e instanceof ProviderError || e instanceof UserError)) console.error('[ai-job]', job.id, e);
    await settle(job, { status: 'FAILED', data: { errorMessage: message.slice(0, 1000) }, actual: null });
  }
}

/**
 * Salva a saída gerada. Se o storage falhar DEPOIS de o provedor ter cobrado, o job continua como
 * concluído (o custo é debitado) e o problema fica registrado, em vez de perder o débito.
 */
async function saveOutput(key: string, data: Uint8Array, mime: string, out: Partial<Prisma.AIJobUpdateInput>): Promise<boolean> {
  try {
    const stored = await storeOutput({ key, bytes: data, mime });
    out.outputMimeType = mime;
    if (stored.url) out.outputUrl = stored.url;
    if (stored.storageKey) out.outputStorageKey = stored.storageKey;
    return true;
  } catch (e) {
    console.error('[ai-job] falha ao salvar saída', key, e);
    out.errorMessage = 'Gerado e cobrado pelo provedor, mas o arquivo não pôde ser salvo (storage indisponível).';
    return false;
  }
}

/** Fecha o job: libera a reserva e, havendo custo confirmado, lança o débito na carteira (atômico). */
async function settle(
  job: Pick<AIJob, 'id' | 'workspaceId' | 'clientId' | 'providerModelId' | 'task'>,
  r: { status: 'SUCCEEDED' | 'FAILED'; data: Partial<Prisma.AIJobUpdateInput>; actual: { cost: Decimal; source: 'REPORTED' | 'COMPUTED' } | null },
) {
  await prisma.$transaction(async (tx) => {
    await lockWallet(tx, job.workspaceId);
    const current = await tx.aIJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    if (current.status !== 'RUNNING') return; // já encerrado pelo reaper: não debitar duas vezes
    const confirmed = r.status === 'SUCCEEDED' ? r.actual : null;
    await tx.aIJob.update({
      where: { id: job.id },
      data: {
        ...r.data,
        status: r.status,
        reservedAmount: 0,
        completedAt: new Date(),
        actualCost: confirmed ? confirmed.cost.toString() : null,
        costSource: confirmed?.source ?? null,
      },
    });
    if (confirmed && confirmed.cost.gt(0)) {
      await postLedger(tx, {
        workspaceId: job.workspaceId,
        clientId: job.clientId,
        aiJobId: job.id,
        type: 'DEBIT',
        amount: confirmed.cost,
        description: `${job.task} · ${job.providerModelId} (${confirmed.source === 'REPORTED' ? 'custo informado pelo provedor' : 'custo calculado'}, ${usd(confirmed.cost)})`,
      });
    }
  });
}

/**
 * Consulta um job de vídeo em andamento. Quando o provedor termina: baixa o arquivo, guarda, confirma o custo
 * (preço por segundo × duração, informado no cadastro do modelo) e libera a reserva. Falha do provedor libera a reserva sem débito.
 * Erros transitórios de consulta/download mantêm o job RUNNING para tentar de novo.
 */
export async function pollVideoJob(jobId: string): Promise<'RUNNING' | 'SUCCEEDED' | 'FAILED'> {
  const job = await prisma.aIJob.findUniqueOrThrow({ where: { id: jobId }, include: { provider: true, model: true } });
  if (job.status === 'SUCCEEDED' || job.status === 'FAILED' || job.status === 'CANCELLED') return job.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
  if (job.modality !== 'VIDEO' || !job.providerRequestId) return 'RUNNING'; // ainda sendo enviado

  const fail = async (message: string) => {
    await settle(job, { status: 'FAILED', data: { errorMessage: message.slice(0, 1000) }, actual: null });
    return 'FAILED' as const;
  };
  try {
    const adapter = createAdapter(job.provider.adapter, { baseUrl: job.provider.baseUrl, apiKey: decryptSecret(job.provider.secretCiphertext) });
    if (!adapter.pollVideo || !adapter.downloadVideo) return await fail('Este provedor não consulta vídeos.');
    const st = await adapter.pollVideo(job.providerRequestId);
    if (!st.done) return 'RUNNING';
    if (st.error || !st.videoRef) return await fail(st.error ?? 'O provedor não devolveu o vídeo.');

    const bytes = await adapter.downloadVideo(st.videoRef);
    const out: Partial<Prisma.AIJobUpdateInput> = { errorMessage: null };
    if (!(await saveOutput(`ai/${job.workspaceId}/${job.id}.mp4`, bytes, 'video/mp4', out)) || (!out.outputUrl && !out.outputStorageKey)) {
      return await fail('O vídeo foi gerado e cobrado pelo provedor, mas não pôde ser salvo (storage indisponível).');
    }
    const estimate = job.estimatedCost ? dec(job.estimatedCost) : null;
    await settle(job, { status: 'SUCCEEDED', data: out, actual: estimate ? { cost: estimate, source: 'COMPUTED' } : null });
    return 'SUCCEEDED';
  } catch (e) {
    const known = e instanceof ProviderError || e instanceof UserError;
    if (!known) console.error('[ai-video-poll]', job.id, e);
    if (Date.now() - job.createdAt.getTime() > STALE_VIDEO_AFTER_MS) return await fail('O vídeo não ficou pronto em 45 minutos.');
    // transitório: mantém RUNNING; deixa o motivo visível sem encerrar
    await prisma.aIJob.update({ where: { id: job.id }, data: { errorMessage: (known ? (e as Error).message : 'Falha temporária ao consultar o vídeo.').slice(0, 500) } });
    return 'RUNNING';
  }
}

/** Submete e executa em sequência (modalidades curtas: texto/imagem/áudio). */
export async function runAIJob(input: SubmitInput): Promise<string> {
  const id = await submitAIJob(input);
  await executeAIJob(id);
  return id;
}
