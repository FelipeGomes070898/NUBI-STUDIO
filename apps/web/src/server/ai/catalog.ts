import type { AIModality } from '@social-manager/db';
import type { ModelPricing } from './types';

/**
 * `/models` no padrão OpenAI não informa modalidade. Inferimos pelo id e pelos metadados quando existem
 * (ex.: OpenRouter envia architecture.output_modalities). É só um PONTO DE PARTIDA: o usuário confirma/edita
 * as modalidades na tela, e a sincronização nunca sobrescreve o que ele editou.
 */
const IMAGE_HINT = /(image|dall-?e|imagen|flux|stable-?diffusion|sdxl|midjourney|ideogram|recraft|gpt-image)/i;
const VIDEO_HINT = /(video|veo|kling|sora|seedance|runway|luma|hailuo|wan-?\d|pika|ray-?\d)/i;
const AUDIO_HINT = /(tts|whisper|speech|audio|voice|eleven|suno|musicgen)/i;

export function inferModalities(id: string, raw?: unknown): AIModality[] {
  const meta = raw as { architecture?: { output_modalities?: unknown } } | undefined;
  const declared = meta?.architecture?.output_modalities;
  if (Array.isArray(declared)) {
    const map: Record<string, AIModality> = { text: 'TEXT', image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO' };
    const out = [...new Set(declared.map((d) => map[String(d).toLowerCase()]).filter(Boolean))];
    if (out.length) return out;
  }
  if (VIDEO_HINT.test(id)) return ['VIDEO'];
  if (IMAGE_HINT.test(id)) return ['IMAGE'];
  if (AUDIO_HINT.test(id)) return ['AUDIO'];
  return ['TEXT'];
}

/** Catálogos estilo OpenRouter trazem pricing.prompt/completion em USD por TOKEN (string). */
export function pricingFromCatalog(raw: unknown): ModelPricing | undefined {
  const p = (raw as { pricing?: Record<string, unknown> } | undefined)?.pricing;
  if (!p) return undefined;
  const prompt = Number(p.prompt);
  const completion = Number(p.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return undefined;
  if (prompt === 0 && completion === 0) return undefined; // 0/0 costuma significar "não informado"
  return { inputPerMTok: prompt * 1e6, outputPerMTok: completion * 1e6 };
}
