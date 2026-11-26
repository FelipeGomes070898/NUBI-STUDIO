import type { AIModality, AITask } from '@social-manager/db';

/** Preços em USD. Todos opcionais: o que não se aplica ao modelo fica de fora. */
export interface ModelPricing {
  inputPerMTok?: number; // texto: por 1M tokens de entrada
  outputPerMTok?: number; // texto: por 1M tokens de saída
  perImage?: number; // imagem: por imagem gerada
  perSecond?: number; // vídeo/áudio: por segundo gerado
  perMChar?: number; // narração: por 1M caracteres de entrada
  perRequest?: number; // preço fixo por chamada
}

export const TASK_MODALITY: Record<AITask, AIModality> = {
  SCRIPT: 'TEXT',
  SCRIPT_REVISION: 'TEXT',
  CAPTION: 'TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  NARRATION: 'AUDIO',
};

export const TASK_LABEL: Record<AITask, string> = {
  SCRIPT: 'Criar roteiro',
  SCRIPT_REVISION: 'Melhorar roteiro',
  CAPTION: 'Legendas e descrições',
  IMAGE: 'Gerar imagens',
  VIDEO: 'Gerar vídeos',
  NARRATION: 'Criar narração',
};

/** Parâmetros de uma geração. Cada tarefa usa o subconjunto que lhe interessa. */
export interface GenerationParams {
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  imageCount?: number;
  imageSize?: string;
  durationSec?: number;
  voice?: string;
  /** Proporção do vídeo/imagem ("9:16", "16:9"). */
  aspectRatio?: string;
  negativePrompt?: string;
  /** Imagens de referência (URLs públicas): personagem fixo no vídeo e na thumbnail. */
  referenceImageUrls?: string[];
}

export interface DiscoveredModel {
  providerModelId: string;
  displayName: string;
  modalities: AIModality[];
  /** Só presente quando o catálogo do provedor informa preço. */
  pricing?: ModelPricing;
}

export interface TextResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Custo em USD informado pelo provedor, quando disponível. */
  reportedCost?: number;
  requestId?: string;
}

export interface ImageResult {
  images: Array<{ b64?: string; url?: string }>;
  /** true quando as imagens de referência (personagem) foram realmente usadas pelo modelo. */
  referenceUsed?: boolean;
  reportedCost?: number;
  requestId?: string;
}

export interface AudioResult {
  audio: Uint8Array;
  mimeType: string;
  requestId?: string;
}

/** Contrato dos adapters (ver docs/INTEGRATION_CONTRACT.md). O catálogo do provedor é a fonte da verdade. */
export interface AIProviderAdapter {
  readonly supports: Record<AIModality, boolean>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  listModels(): Promise<DiscoveredModel[]>;
  generateText(req: { model: string; prompt: string } & GenerationParams): Promise<TextResult>;
  generateImage(req: { model: string; prompt: string } & GenerationParams): Promise<ImageResult>;
  generateSpeech(req: { model: string; input: string; voice?: string }): Promise<AudioResult>;
  /** Vídeo é assíncrono: submitVideo devolve um id de operação; pollVideo consulta; downloadVideo baixa o arquivo. */
  submitVideo?(req: { model: string; prompt: string } & GenerationParams): Promise<VideoSubmitResult>;
  pollVideo?(operationId: string): Promise<VideoPollResult>;
  downloadVideo?(videoRef: string): Promise<Uint8Array>;
}

export interface VideoSubmitResult {
  operationId: string;
}

export interface VideoPollResult {
  done: boolean;
  /** Referência do arquivo pronto (entregue a downloadVideo). */
  videoRef?: string;
  /** Motivo da falha (mensagem já segura para mostrar). */
  error?: string;
}

/** Erro do provedor com mensagem já sanitizada (sem chave, sem corpo bruto longo). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
