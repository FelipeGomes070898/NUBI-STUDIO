import Decimal from 'decimal.js';
import type { AIAdapterType, AIModality, AITask, SelectionMode } from '@social-manager/db';
import { estimateCost, type PricedRequest } from './pricing';
import { TASK_LABEL, TASK_MODALITY, type ModelPricing } from './types';

export interface RoutableProvider {
  id: string;
  name: string;
  adapter: AIAdapterType;
  isActive: boolean;
  isPrimary: boolean;
}

export interface RoutableModel {
  id: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  modalities: AIModality[];
  pricing: ModelPricing | null;
  isActive: boolean;
}

export interface RoutablePreference {
  mode: SelectionMode;
  modelId: string | null;
  fallbackModelIds: string[];
}

export interface RouteEntry {
  model: RoutableModel;
  provider: RoutableProvider;
  /** Limite superior do custo; null = modelo sem preço cadastrado. */
  estimate: Decimal | null;
}

export interface RoutePlan {
  selectionMode: SelectionMode;
  /** Candidatos em ordem de tentativa (o primeiro que couber no orçamento é usado). */
  entries: RouteEntry[];
  reason: string;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

export interface PlanInput {
  task: AITask;
  request: PricedRequest;
  providers: RoutableProvider[];
  models: RoutableModel[];
  preference: RoutablePreference | null;
  /** Modelo escolhido explicitamente pelo usuário nesta geração (sempre manual, sem fallback). */
  requestedModelId?: string | null;
  /** O adapter do provedor sabe executar essa modalidade? */
  isSupported: (adapter: AIAdapterType, modality: AIModality) => boolean;
}

/**
 * Decide quais modelos podem atender o pedido e em que ordem.
 *  - Escolha explícita no pedido → só ela. Falha com motivo claro, sem trocar de modelo por conta própria.
 *  - Preferência MANUAL da tarefa → modelo fixo + alternativas aprovadas pelo workspace.
 *  - AUTO → modelos preferidos/aprovados da tarefa; sem eles, todos os compatíveis, ordenados por
 *    provedor principal → custo estimado (sem preço por último) → nome.
 * Função pura: não acessa banco nem rede.
 */
export function planRoute(input: PlanInput): RoutePlan {
  const { task, request, providers, models, preference, requestedModelId, isSupported } = input;
  const modality = TASK_MODALITY[task];
  const providerById = new Map(providers.map((p) => [p.id, p]));
  const modelById = new Map(models.map((m) => [m.id, m]));

  const whyUnusable = (m: RoutableModel): string | null => {
    const p = providerById.get(m.providerId);
    if (!p) return 'provedor não encontrado';
    if (!p.isActive) return `o provedor "${p.name}" está desativado`;
    if (!m.isActive) return 'o modelo está desativado';
    if (!m.modalities.includes(modality)) return `o modelo não está marcado para ${modality}`;
    if (!isSupported(p.adapter, modality))
      return `o adapter do provedor "${p.name}" ainda não executa ${modality} (suporte pendente)`;
    return null;
  };

  const toEntry = (m: RoutableModel): RouteEntry => ({
    model: m,
    provider: providerById.get(m.providerId)!,
    estimate: estimateCost(m.pricing, modality, request),
  });

  const usable = (m: RoutableModel | undefined): m is RoutableModel => !!m && whyUnusable(m) === null;

  // 1) escolha explícita
  if (requestedModelId) {
    const m = modelById.get(requestedModelId);
    if (!m) throw new RoutingError('O modelo escolhido não existe mais. Sincronize o catálogo do gateway.');
    const why = whyUnusable(m);
    if (why) throw new RoutingError(`Modelo "${m.displayName}" indisponível para ${TASK_LABEL[task]}: ${why}.`);
    return { selectionMode: 'MANUAL', entries: [toEntry(m)], reason: 'Modelo escolhido manualmente.' };
  }

  const approved = preference
    ? [preference.modelId, ...preference.fallbackModelIds]
        .filter((id): id is string => !!id)
        .map((id) => modelById.get(id))
        .filter(usable)
    : [];

  // 2) preferência manual da tarefa
  if (preference?.mode === 'MANUAL') {
    if (!preference.modelId) {
      throw new RoutingError(
        `A tarefa "${TASK_LABEL[task]}" está em modo manual sem modelo definido. Escolha um modelo em Central de IA.`,
      );
    }
    if (approved.length === 0) {
      const m = modelById.get(preference.modelId);
      const why = m ? whyUnusable(m) : 'o modelo não existe mais';
      throw new RoutingError(`Modelo manual da tarefa "${TASK_LABEL[task]}" indisponível: ${why}.`);
    }
    return {
      selectionMode: 'MANUAL',
      entries: approved.map(toEntry),
      reason: 'Modelo fixo da tarefa (modo manual); alternativas apenas as aprovadas no workspace.',
    };
  }

  // 3) automático
  if (approved.length > 0) {
    return {
      selectionMode: 'AUTO',
      entries: approved.map(toEntry),
      reason: 'Automático: modelos preferidos/aprovados da tarefa, na ordem de prioridade.',
    };
  }

  const pool = models.filter(usable).map(toEntry);
  if (pool.length === 0) {
    throw new RoutingError(
      `Nenhum modelo ativo e compatível com ${modality} (${TASK_LABEL[task]}). ` +
        'Cadastre um gateway, sincronize os modelos e ative ao menos um com essa modalidade.',
    );
  }
  pool.sort((a, b) => {
    if (a.provider.isPrimary !== b.provider.isPrimary) return a.provider.isPrimary ? -1 : 1;
    if ((a.estimate === null) !== (b.estimate === null)) return a.estimate === null ? 1 : -1;
    if (a.estimate && b.estimate && !a.estimate.eq(b.estimate)) return a.estimate.cmp(b.estimate);
    return a.model.displayName.localeCompare(b.model.displayName);
  });
  return {
    selectionMode: 'AUTO',
    entries: pool,
    reason: preference?.modelId
      ? 'Automático: modelo preferido indisponível; escolhido pelo provedor principal e menor custo estimado.'
      : 'Automático: provedor principal e menor custo estimado.',
  };
}
