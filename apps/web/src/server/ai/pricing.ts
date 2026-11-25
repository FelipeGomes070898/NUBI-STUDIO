import Decimal from 'decimal.js';
import type { AIModality } from '@social-manager/db';
import type { GenerationParams, ModelPricing } from './types';

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;
export const DEFAULT_IMAGE_COUNT = 1;
export const DEFAULT_VIDEO_SECONDS = 5;
/** Narração falada ≈ 15 caracteres por segundo (usado só para estimar preço por segundo). */
const CHARS_PER_SECOND = 15;
const M = new Decimal(1_000_000);

const PRICING_KEYS = ['inputPerMTok', 'outputPerMTok', 'perImage', 'perSecond', 'perMChar', 'perRequest'] as const;

/** Valida o JSON vindo do banco/formulário. Devolve null se não houver nenhum preço válido. */
export function parsePricing(raw: unknown): ModelPricing | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: ModelPricing = {};
  for (const k of PRICING_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** Estimativa conservadora (≈3 caracteres/token) — melhor reter a mais do que de menos. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface PricedRequest {
  prompt: string;
  params: GenerationParams;
}

export function maxOutputTokens(params: GenerationParams): number {
  return params.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
}

/**
 * Custo máximo esperado (limite superior) de uma chamada. É usado para RETER valor na carteira.
 * Retorna null quando o modelo não tem preço aplicável à modalidade ("não controlável").
 */
export function estimateCost(pricing: ModelPricing | null, modality: AIModality, req: PricedRequest): Decimal | null {
  if (!pricing) return null;
  const fixed = new Decimal(pricing.perRequest ?? 0);
  const { prompt, params } = req;

  switch (modality) {
    case 'TEXT': {
      if (pricing.inputPerMTok === undefined || pricing.outputPerMTok === undefined) return null;
      const inTok = estimateTokens((params.system ?? '') + prompt);
      return new Decimal(inTok)
        .mul(pricing.inputPerMTok)
        .add(new Decimal(maxOutputTokens(params)).mul(pricing.outputPerMTok))
        .div(M)
        .add(fixed);
    }
    case 'IMAGE': {
      if (pricing.perImage === undefined && pricing.perRequest === undefined) return null;
      return new Decimal(pricing.perImage ?? 0).mul(params.imageCount ?? DEFAULT_IMAGE_COUNT).add(fixed);
    }
    case 'VIDEO': {
      if (pricing.perSecond === undefined && pricing.perRequest === undefined) return null;
      return new Decimal(pricing.perSecond ?? 0).mul(params.durationSec ?? DEFAULT_VIDEO_SECONDS).add(fixed);
    }
    case 'AUDIO': {
      if (pricing.perMChar !== undefined) return new Decimal(prompt.length).mul(pricing.perMChar).div(M).add(fixed);
      if (pricing.perSecond !== undefined)
        return new Decimal(Math.ceil(prompt.length / CHARS_PER_SECOND)).mul(pricing.perSecond).add(fixed);
      return pricing.perRequest !== undefined ? fixed : null;
    }
  }
}

export interface TextUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Custo confirmado de texto a partir do uso real; sem uso informado, cai na estimativa (limite superior). */
export function computeTextCost(pricing: ModelPricing, usage: TextUsage, estimate: Decimal): Decimal {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return estimate;
  if (pricing.inputPerMTok === undefined || pricing.outputPerMTok === undefined) return estimate;
  return new Decimal(usage.inputTokens)
    .mul(pricing.inputPerMTok)
    .add(new Decimal(usage.outputTokens).mul(pricing.outputPerMTok))
    .div(M)
    .add(pricing.perRequest ?? 0);
}

export function usd(d: Decimal.Value): string {
  const v = new Decimal(d);
  return `$${v.abs().lt(0.01) && !v.isZero() ? v.toFixed(6) : v.toFixed(4)}`;
}
