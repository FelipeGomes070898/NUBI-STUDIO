import type { AIModality } from '@social-manager/db';
import {
  ProviderError,
  type AIProviderAdapter,
  type AudioResult,
  type DiscoveredModel,
  type GenerationParams,
  type ImageResult,
  type TextResult,
  type VideoPollResult,
  type VideoSubmitResult,
} from '../types';

export const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';
const OPERATION = /^models\/[A-Za-z0-9._-]+\/operations\/[A-Za-z0-9._-]+$/;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

export interface GeminiOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * API do Google (chave do AI Studio): texto (Gemini) e vídeo (Veo, assíncrono: envia → consulta → baixa).
 * Imagem e áudio NÃO são executados por este adapter (use o gateway OpenAI-compatível para isso).
 */
export class GoogleGeminiAdapter implements AIProviderAdapter {
  readonly supports: Record<AIModality, boolean> = { TEXT: true, IMAGE: false, AUDIO: false, VIDEO: true };

  private readonly base: string;
  private readonly key: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;

  constructor(o: GeminiOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.key = o.apiKey;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 120_000;
  }

  private url(path: string) {
    return `${this.base}/v1beta/${path.replace(/^\/+/, '')}`;
  }

  async healthCheck() {
    const t0 = Date.now();
    try {
      await this.call('GET', 'models?pageSize=1', undefined, 15_000);
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const out: DiscoveredModel[] = [];
    let token = '';
    for (let page = 0; page < 10; page++) {
      const j = await this.call('GET', `models?pageSize=200${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      for (const m of Array.isArray(j.models) ? j.models : []) {
        const id = typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null;
        if (!id) continue;
        const methods: string[] = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        const modalities: AIModality[] = [];
        if (methods.includes('predictLongRunning') && /veo/i.test(id)) modalities.push('VIDEO');
        else if (methods.includes('generateContent') && !/image|tts|embedding|aqa/i.test(id)) modalities.push('TEXT');
        if (modalities.length) out.push({ providerModelId: id, displayName: typeof m.displayName === 'string' && m.displayName ? m.displayName : id, modalities });
      }
      token = typeof j.nextPageToken === 'string' ? j.nextPageToken : '';
      if (!token) break;
    }
    return out;
  }

  async generateText(req: { model: string; prompt: string } & GenerationParams): Promise<TextResult> {
    const j = await this.call('POST', `models/${encodeURIComponent(req.model)}:generateContent`, {
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      generationConfig: { ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}), ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
    });
    const parts = j.candidates?.[0]?.content?.parts;
    const text = Array.isArray(parts) ? parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('') : '';
    if (!text) throw new ProviderError('O Gemini não devolveu texto (a resposta pode ter sido bloqueada pelos filtros).');
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return { text, inputTokens: n(j.usageMetadata?.promptTokenCount), outputTokens: n(j.usageMetadata?.candidatesTokenCount) };
  }

  async generateImage(_req: { model: string; prompt: string } & GenerationParams): Promise<ImageResult> {
    throw new ProviderError('Este provedor não gera imagens. Use o gateway OpenAI-compatível para imagens.');
  }

  async generateSpeech(): Promise<AudioResult> {
    throw new ProviderError('Este provedor não gera narração.');
  }

  /** Inicia a geração do clipe. Com imagem de referência, usa a primeira como imagem inicial (personagem). */
  async submitVideo(req: { model: string; prompt: string } & GenerationParams): Promise<VideoSubmitResult> {
    const instance: Record<string, unknown> = { prompt: req.prompt };
    const ref = req.referenceImageUrls?.[0];
    if (ref) {
      const img = await this.fetchReference(ref);
      instance.image = { bytesBase64Encoded: Buffer.from(img.bytes).toString('base64'), mimeType: img.mime };
    }
    const j = await this.call('POST', `models/${encodeURIComponent(req.model)}:predictLongRunning`, {
      instances: [instance],
      parameters: {
        aspectRatio: req.aspectRatio ?? '9:16',
        ...(req.durationSec ? { durationSeconds: req.durationSec } : {}),
        ...(req.negativePrompt ? { negativePrompt: req.negativePrompt } : {}),
      },
    });
    if (typeof j.name !== 'string' || !OPERATION.test(j.name)) throw new ProviderError('O Google não devolveu o identificador da operação de vídeo.');
    return { operationId: j.name };
  }

  async pollVideo(operationId: string): Promise<VideoPollResult> {
    if (!OPERATION.test(operationId)) throw new ProviderError('Identificador de operação inválido.');
    const j = await this.call('GET', operationId);
    if (!j.done) return { done: false };
    if (j.error) return { done: true, error: `O Google recusou o vídeo: ${String(j.error.message ?? j.error.code ?? 'erro').replace(/\s+/g, ' ').slice(0, 200)}` };
    const resp = j.response?.generateVideoResponse;
    const uri = resp?.generatedSamples?.[0]?.video?.uri;
    if (typeof uri === 'string') return { done: true, videoRef: uri };
    const reasons = Array.isArray(resp?.raiMediaFilteredReasons) ? resp.raiMediaFilteredReasons.join('; ') : '';
    return { done: true, error: `O Google bloqueou o vídeo pelos filtros de segurança${reasons ? `: ${reasons.slice(0, 200)}` : ''}. Reescreva a cena e tente de novo.` };
  }

  /** Baixa o arquivo. A chave só vai para o host do Google; redirecionamentos vão sem a chave e só para domínios do Google. */
  async downloadVideo(videoRef: string): Promise<Uint8Array> {
    let url = new URL(videoRef);
    if (url.hostname !== new URL(this.base).hostname || url.protocol !== 'https:' && !this.base.startsWith('http://')) throw new ProviderError('Endereço de vídeo fora do Google; abortado.');
    let withKey = true;
    for (let hop = 0; hop < 4; hop++) {
      const res = await this.f(url, { headers: withKey ? { 'x-goog-api-key': this.key } : {}, redirect: 'manual', signal: AbortSignal.timeout(this.timeoutMs) }).catch((e: Error) => { throw new ProviderError(`Falha de rede ao baixar o vídeo: ${e.message}`); });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new ProviderError('Redirecionamento sem destino ao baixar o vídeo.');
        url = new URL(loc, url);
        if (!/(^|\.)(googleapis|googleusercontent)\.com$/.test(url.hostname) && url.hostname !== new URL(this.base).hostname) throw new ProviderError('O Google redirecionou o vídeo para fora dos seus domínios; abortado.');
        withKey = url.hostname === new URL(this.base).hostname;
        continue;
      }
      if (!res.ok) throw new ProviderError(`Não foi possível baixar o vídeo (HTTP ${res.status}).`);
      const len = Number(res.headers.get('content-length'));
      if (len > MAX_VIDEO_BYTES) throw new ProviderError('O vídeo gerado é grande demais.');
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_VIDEO_BYTES) throw new ProviderError('Arquivo de vídeo vazio ou grande demais.');
      return buf;
    }
    throw new ProviderError('Redirecionamentos demais ao baixar o vídeo.');
  }

  // ── HTTP ──────────────────────────────────────────────

  private async fetchReference(refUrl: string): Promise<{ bytes: Uint8Array; mime: string }> {
    const res = await this.f(refUrl, { signal: AbortSignal.timeout(30_000), redirect: 'error' }).catch((e: Error) => { throw new ProviderError(`Não foi possível ler a imagem do personagem: ${e.message}`); });
    if (!res.ok) throw new ProviderError(`Não foi possível ler a imagem do personagem (HTTP ${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const mime = (res.headers.get('content-type') ?? '').split(';')[0]!.trim();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new ProviderError('A imagem do personagem precisa ser PNG, JPG ou WebP.');
    if (bytes.byteLength > MAX_REFERENCE_BYTES) throw new ProviderError('A imagem do personagem passa de 8 MB.');
    return { bytes, mime };
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, timeout = this.timeoutMs): Promise<Record<string, any>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await this.f(this.url(path), {
        method,
        headers: { 'x-goog-api-key': this.key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      }).catch((e: Error) => {
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        throw new ProviderError(timedOut ? `Tempo esgotado após ${Math.round(timeout / 1000)}s.` : `Falha de rede ao chamar o Google: ${e.message}`);
      });
      const j = (await res.json().catch(() => null)) as Record<string, any> | null;
      if (res.ok) return j ?? {};
      if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; } // recusado antes de processar: não gera cobrança
      const detail = String(j?.error?.message ?? '').replace(/\s+/g, ' ').slice(0, 300);
      const hint = res.status === 400 && /API key/i.test(detail) ? ' (chave de API inválida)' : res.status === 403 ? ' (chave sem permissão ou faturamento não habilitado para este modelo)' : res.status === 404 ? ' (modelo ou endpoint não encontrado)' : res.status === 429 ? ' (limite de requisições/cota)' : '';
      throw new ProviderError(`O Google respondeu HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`, res.status, res.status === 429);
    }
    throw new ProviderError('O Google limitou as requisições (HTTP 429).', 429, true);
  }
}
