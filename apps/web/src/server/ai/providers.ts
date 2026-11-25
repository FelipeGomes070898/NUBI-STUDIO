import { prisma, Prisma, type AIModality, type AIProviderKind, type AITask, type SelectionMode } from '@social-manager/db';
import { decryptSecret, encryptSecret, secretHint } from '../crypto';
import { UserError } from '../errors';
import { createAdapter } from './adapters';
import { parsePricing } from './pricing';
import { TASK_MODALITY, type ModelPricing } from './types';

/** Só https (ou http em localhost, p/ gateways locais), sem credenciais embutidas. */
export function normalizeBaseUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new UserError('URL base inválida. Exemplo: https://api.seu-gateway.com/v1');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new UserError('A URL base precisa usar https.');
  if (u.username || u.password) throw new UserError('Não coloque usuário/senha na URL; use o campo de chave.');
  if (u.search || u.hash) throw new UserError('A URL base não deve ter query string nem fragmento.');
  return u.toString().replace(/\/+$/, '');
}

export async function createProvider(input: {
  workspaceId: string;
  name: string;
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
}) {
  const name = input.name.trim();
  if (!name) throw new UserError('Informe um nome para o provedor.');
  if (input.apiKey.trim().length < 8) throw new UserError('Chave de API inválida.');
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();

  return prisma.$transaction(async (tx) => {
    const count = await tx.aIProvider.count({ where: { workspaceId: input.workspaceId } });
    try {
      return await tx.aIProvider.create({
        data: {
          workspaceId: input.workspaceId,
          name,
          kind: input.kind,
          baseUrl,
          secretCiphertext: encryptSecret(apiKey),
          secretHint: secretHint(apiKey),
          isPrimary: count === 0,
        },
        select: { id: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new UserError(`Já existe um provedor chamado "${name}".`);
      throw e;
    }
  });
}

export async function rotateProviderKey(workspaceId: string, providerId: string, apiKey: string) {
  if (apiKey.trim().length < 8) throw new UserError('Chave de API inválida.');
  const r = await prisma.aIProvider.updateMany({
    where: { id: providerId, workspaceId },
    data: { secretCiphertext: encryptSecret(apiKey.trim()), secretHint: secretHint(apiKey.trim()), lastTestOk: null, lastTestError: null, lastTestedAt: null },
  });
  if (r.count === 0) throw new UserError('Provedor não encontrado.');
}

async function loadAdapter(workspaceId: string, providerId: string) {
  const p = await prisma.aIProvider.findFirst({ where: { id: providerId, workspaceId } });
  if (!p) throw new UserError('Provedor não encontrado.');
  return { provider: p, adapter: createAdapter(p.adapter, { baseUrl: p.baseUrl, apiKey: decryptSecret(p.secretCiphertext) }) };
}

export async function testProvider(workspaceId: string, providerId: string) {
  const { provider, adapter } = await loadAdapter(workspaceId, providerId);
  const r = await adapter.healthCheck();
  await prisma.aIProvider.update({
    where: { id: provider.id },
    data: { lastTestedAt: new Date(), lastTestOk: r.ok, lastTestError: r.ok ? null : (r.error ?? 'Falha desconhecida').slice(0, 500) },
  });
  return r;
}

/**
 * Importa o catálogo do provedor. Modelos novos entram DESATIVADOS (o roteamento automático nunca usa
 * um modelo que você não habilitou). Modelos já existentes preservam modalidades e ativação editadas
 * por você; o preço só é atualizado se ele veio do próprio catálogo (não se foi informado manualmente).
 */
export async function syncProviderModels(workspaceId: string, providerId: string) {
  const { provider, adapter } = await loadAdapter(workspaceId, providerId);
  let discovered;
  try {
    discovered = await adapter.listModels();
  } catch (e) {
    await prisma.aIProvider.update({ where: { id: provider.id }, data: { lastTestedAt: new Date(), lastTestOk: false, lastTestError: (e as Error).message.slice(0, 500) } });
    throw new UserError(`Não foi possível listar os modelos: ${(e as Error).message}`);
  }
  const existing = new Map((await prisma.aIModel.findMany({ where: { providerId } })).map((m) => [m.providerModelId, m]));
  let created = 0;
  let updated = 0;

  await prisma.$transaction(async (tx) => {
    for (const d of discovered) {
      const cur = existing.get(d.providerModelId);
      if (!cur) {
        await tx.aIModel.create({
          data: {
            providerId,
            providerModelId: d.providerModelId,
            displayName: d.displayName,
            modalities: d.modalities,
            pricing: (d.pricing as Prisma.InputJsonValue) ?? undefined,
            pricingSource: d.pricing ? 'PROVIDER' : null,
            isActive: false,
          },
        });
        created++;
      } else {
        const refreshPrice = d.pricing && cur.pricingSource !== 'MANUAL';
        await tx.aIModel.update({
          where: { id: cur.id },
          data: { displayName: d.displayName, ...(refreshPrice ? { pricing: d.pricing as Prisma.InputJsonValue, pricingSource: 'PROVIDER' } : {}) },
        });
        updated++;
      }
    }
    await tx.aIProvider.update({ where: { id: providerId }, data: { lastSyncedAt: new Date(), lastTestedAt: new Date(), lastTestOk: true, lastTestError: null } });
  });
  return { total: discovered.length, created, updated };
}

export async function setProviderActive(workspaceId: string, providerId: string, isActive: boolean) {
  const r = await prisma.aIProvider.updateMany({ where: { id: providerId, workspaceId }, data: { isActive, ...(isActive ? {} : { isPrimary: false }) } });
  if (r.count === 0) throw new UserError('Provedor não encontrado.');
}

export async function setPrimaryProvider(workspaceId: string, providerId: string) {
  await prisma.$transaction(async (tx) => {
    const p = await tx.aIProvider.findFirst({ where: { id: providerId, workspaceId } });
    if (!p) throw new UserError('Provedor não encontrado.');
    if (!p.isActive) throw new UserError('Ative o provedor antes de torná-lo o principal.');
    await tx.aIProvider.updateMany({ where: { workspaceId }, data: { isPrimary: false } });
    await tx.aIProvider.update({ where: { id: providerId }, data: { isPrimary: true } });
  });
}

export async function deleteProvider(workspaceId: string, providerId: string) {
  const jobs = await prisma.aIJob.count({ where: { workspaceId, providerId } });
  if (jobs > 0) throw new UserError('Este provedor tem histórico de gerações e não pode ser excluído. Desative-o.');
  const r = await prisma.aIProvider.deleteMany({ where: { id: providerId, workspaceId } });
  if (r.count === 0) throw new UserError('Provedor não encontrado.');
}

export async function updateModel(
  workspaceId: string,
  modelId: string,
  patch: { isActive?: boolean; modalities?: AIModality[]; pricing?: ModelPricing | null },
) {
  const m = await prisma.aIModel.findFirst({ where: { id: modelId, provider: { workspaceId } } });
  if (!m) throw new UserError('Modelo não encontrado.');
  if (patch.modalities && patch.modalities.length === 0) throw new UserError('Selecione ao menos uma modalidade.');
  const pricing = patch.pricing === undefined ? undefined : patch.pricing === null ? null : parsePricing(patch.pricing);
  await prisma.aIModel.update({
    where: { id: modelId },
    data: {
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(patch.modalities ? { modalities: patch.modalities } : {}),
      ...(pricing !== undefined ? { pricing: pricing === null ? Prisma.DbNull : (pricing as Prisma.InputJsonValue), pricingSource: pricing === null ? null : 'MANUAL' } : {}),
    },
  });
}

export async function saveTaskPreference(
  workspaceId: string,
  p: { task: AITask; mode: SelectionMode; modelId: string | null; fallbackModelIds: string[] },
) {
  const ids = [p.modelId, ...p.fallbackModelIds].filter((x): x is string => !!x);
  if (new Set(ids).size !== ids.length) throw new UserError('Não repita o mesmo modelo como principal e alternativa.');
  const models = await prisma.aIModel.findMany({ where: { id: { in: ids }, provider: { workspaceId } } });
  if (models.length !== ids.length) throw new UserError('Algum modelo escolhido não existe mais.');
  const need = TASK_MODALITY[p.task];
  const bad = models.find((m) => !m.modalities.includes(need));
  if (bad) throw new UserError(`"${bad.displayName}" não está marcado para ${need}; ajuste as modalidades do modelo primeiro.`);
  if (p.mode === 'MANUAL' && !p.modelId) throw new UserError('No modo manual, escolha o modelo da tarefa.');

  await prisma.aITaskPreference.upsert({
    where: { workspaceId_task: { workspaceId, task: p.task } },
    create: { workspaceId, task: p.task, mode: p.mode, modelId: p.modelId, fallbackModelIds: p.fallbackModelIds },
    update: { mode: p.mode, modelId: p.modelId, fallbackModelIds: p.fallbackModelIds },
  });
}
