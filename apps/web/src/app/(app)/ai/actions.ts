'use server';
import type { AIModality, AITask } from '@social-manager/db';
import { run } from '@/lib/action';
import { bool, oneOf, str } from '@/lib/form';
import {
  createProvider, deleteProvider, rotateProviderKey, saveTaskPreference, setPrimaryProvider, setProviderActive, syncProviderModels, testProvider, updateModel,
} from '@/server/ai/providers';
import { UserError } from '@/server/errors';
import type { ModelPricing } from '@/server/ai/types';

const MODALITIES: AIModality[] = ['TEXT', 'IMAGE', 'VIDEO', 'AUDIO'];
const TASKS: AITask[] = ['SCRIPT', 'SCRIPT_REVISION', 'CAPTION', 'IMAGE', 'VIDEO', 'NARRATION'];

export async function createProviderAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await createProvider({ workspaceId: ws, name: str(fd, 'name'), kind: oneOf(fd, 'kind', ['UNIFIED', 'DIRECT'] as const, 'Tipo'), baseUrl: str(fd, 'baseUrl'), apiKey: str(fd, 'apiKey') });
    return 'Provedor cadastrado. Teste a conexão e sincronize os modelos.';
  });
}

export async function testProviderAction(fd: FormData) {
  await run('/ai', async (ws) => {
    const r = await testProvider(ws, str(fd, 'entityId'));
    if (!r.ok) throw new UserError(`Conexão falhou: ${r.error}`);
    return `Conexão OK (${r.latencyMs} ms).`;
  });
}

export async function syncModelsAction(fd: FormData) {
  await run('/ai', async (ws) => {
    const r = await syncProviderModels(ws, str(fd, 'entityId'));
    return `${r.total} modelos no catálogo: ${r.created} novos (desativados até você habilitar), ${r.updated} já existentes.`;
  });
}

export async function toggleProviderAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await setProviderActive(ws, str(fd, 'entityId'), bool(fd, 'active'));
    return 'Provedor atualizado.';
  });
}

export async function primaryProviderAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await setPrimaryProvider(ws, str(fd, 'entityId'));
    return 'Provedor principal definido.';
  });
}

export async function rotateKeyAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await rotateProviderKey(ws, str(fd, 'entityId'), str(fd, 'apiKey'));
    return 'Chave substituída. Teste a conexão.';
  });
}

export async function deleteProviderAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await deleteProvider(ws, str(fd, 'entityId'));
    return 'Provedor excluído.';
  });
}

const num = (fd: FormData, k: string): number | undefined => {
  const raw = str(fd, k).replace(',', '.');
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new UserError('Preços devem ser números maiores ou iguais a zero.');
  return n;
};

export async function saveModelAction(fd: FormData) {
  const back = `/ai${str(fd, 'q') ? `?q=${encodeURIComponent(str(fd, 'q'))}` : ''}`;
  await run(back, async (ws) => {
    const modalities = fd.getAll('modalities').map(String).filter((m): m is AIModality => (MODALITIES as string[]).includes(m));
    const pricing: ModelPricing = {};
    for (const k of ['inputPerMTok', 'outputPerMTok', 'perImage', 'perSecond', 'perMChar', 'perRequest'] as const) {
      const v = num(fd, k);
      if (v !== undefined) pricing[k] = v;
    }
    await updateModel(ws, str(fd, 'entityId'), { isActive: bool(fd, 'isActive'), modalities, pricing: Object.keys(pricing).length ? pricing : null });
    return 'Modelo salvo.';
  });
}

export async function activateModelAction(fd: FormData) {
  const back = `/ai${str(fd, 'q') ? `?q=${encodeURIComponent(str(fd, 'q'))}` : ''}`;
  await run(back, async (ws) => {
    await updateModel(ws, str(fd, 'entityId'), { isActive: true });
    return 'Modelo ativado. Informe o preço dele para o controle de custos.';
  });
}

export async function savePreferenceAction(fd: FormData) {
  await run('/ai', async (ws) => {
    await saveTaskPreference(ws, {
      task: oneOf(fd, 'task', TASKS, 'Tarefa'),
      mode: oneOf(fd, 'mode', ['AUTO', 'MANUAL'] as const, 'Modo'),
      modelId: str(fd, 'modelId') || null,
      fallbackModelIds: fd.getAll('fallbackModelIds').map(String).filter(Boolean),
    });
    return 'Preferência da tarefa salva.';
  });
}
