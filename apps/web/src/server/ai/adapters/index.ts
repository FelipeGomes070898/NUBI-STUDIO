import type { AIAdapterType, AIModality } from '@social-manager/db';
import { GoogleGeminiAdapter } from './google-gemini';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { AIProviderAdapter } from '../types';

/** Quais modalidades cada tipo de adapter sabe executar (usado pelo roteamento, sem instanciar nada). */
export const ADAPTER_SUPPORT: Record<AIAdapterType, Record<AIModality, boolean>> = {
  OPENAI_COMPATIBLE: { TEXT: true, IMAGE: true, AUDIO: true, VIDEO: false },
  GOOGLE_GEMINI: { TEXT: true, IMAGE: false, AUDIO: false, VIDEO: true },
};

export const isSupported = (adapter: AIAdapterType, modality: AIModality) => ADAPTER_SUPPORT[adapter][modality];

export function createAdapter(type: AIAdapterType, opts: { baseUrl: string; apiKey: string }): AIProviderAdapter {
  switch (type) {
    case 'OPENAI_COMPATIBLE':
      return new OpenAICompatibleAdapter(opts);
    case 'GOOGLE_GEMINI':
      return new GoogleGeminiAdapter(opts);
  }
}
