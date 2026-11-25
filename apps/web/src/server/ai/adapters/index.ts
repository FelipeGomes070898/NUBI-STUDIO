import type { AIAdapterType, AIModality } from '@social-manager/db';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { AIProviderAdapter } from '../types';

/** Quais modalidades cada tipo de adapter sabe executar (usado pelo roteamento, sem instanciar nada). */
export const ADAPTER_SUPPORT: Record<AIAdapterType, Record<AIModality, boolean>> = {
  OPENAI_COMPATIBLE: { TEXT: true, IMAGE: true, AUDIO: true, VIDEO: false },
};

export const isSupported = (adapter: AIAdapterType, modality: AIModality) => ADAPTER_SUPPORT[adapter][modality];

export function createAdapter(type: AIAdapterType, opts: { baseUrl: string; apiKey: string }): AIProviderAdapter {
  switch (type) {
    case 'OPENAI_COMPATIBLE':
      return new OpenAICompatibleAdapter(opts);
  }
}
