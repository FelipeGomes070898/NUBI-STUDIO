import type { AIModality } from '@social-manager/db';
import { inferModalities, pricingFromCatalog } from '../catalog';
import {
  ProviderError,
  type AIProviderAdapter,
  type AudioResult,
  type DiscoveredModel,
  type GenerationParams,
  type ImageResult,
  type TextResult,
} from '../types';

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Quantidade de novas tentativas para 429/503 (rejeitados antes de processar; não geram cobrança). */
  retries?: number;
  retryDelayMs?: number;
}

/**
 * Adapter para qualquer API no formato OpenAI (`/models`, `/chat/completions`, `/images/generations`,
 * `/audio/speech`): OpenAI, OpenRouter, LiteLLM e a maioria dos gateways unificados.
 * Vídeo NÃO é padronizado entre gateways (cada um tem seu fluxo assíncrono): precisa de adapter próprio.
 */
export class OpenAICompatibleAdapter implements AIProviderAdapter {
  readonly supports: Record<AIModality, boolean> = { TEXT: true, IMAGE: true, AUDIO: true, VIDEO: false };

  private readonly base: string;
  private readonly key: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(o: OpenAICompatibleOptions) {
    this.base = o.baseUrl.replace(/\/+$/, '');
    this.key = o.apiKey;
    this.f = o.fetch ?? fetch;
    this.timeoutMs = o.timeoutMs ?? 120_000;
    this.retries = o.retries ?? 2;
    this.retryDelayMs = o.retryDelayMs ?? 1000;
  }

  async healthCheck() {
    const t0 = Date.now();
    try {
      await this.request('GET', '/models', undefined, { retries: 0, timeoutMs: 15_000 });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message };
    }
  }

  async listModels(): Promise<DiscoveredModel[]> {
    const res = await this.request('GET', '/models');
    const json = (await res.json().catch(() => null)) as { data?: unknown } | null;
    const data = Array.isArray(json?.data) ? (json!.data as Array<Record<string, unknown>>) : null;
    if (!data) throw new ProviderError('Resposta de /models inesperada (esperado { data: [...] }).');
    const seen = new Set<string>();
    const out: DiscoveredModel[] = [];
    for (const m of data) {
      const id = typeof m.id === 'string' ? m.id : null;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        providerModelId: id,
        displayName: typeof m.name === 'string' && m.name ? m.name : id,
        modalities: inferModalities(id, m),
        pricing: pricingFromCatalog(m),
      });
    }
    return out;
  }

  async generateText(req: { model: string; prompt: string } & GenerationParams): Promise<TextResult> {
    const messages = [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      { role: 'user', content: req.prompt },
    ];
    const res = await this.request('POST', '/chat/completions', {
      model: req.model,
      messages,
      max_tokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });
    const j = (await res.json().catch(() => null)) as any;
    const text = j?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new ProviderError('Resposta de /chat/completions sem texto.');
    const cost = Number(j?.usage?.cost);
    return {
      text,
      inputTokens: numOrUndef(j?.usage?.prompt_tokens),
      outputTokens: numOrUndef(j?.usage?.completion_tokens),
      reportedCost: Number.isFinite(cost) && cost >= 0 ? cost : undefined,
      requestId: typeof j?.id === 'string' ? j.id : res.headers.get('x-request-id') ?? undefined,
    };
  }

  /** Baixa até 3 imagens de referência (personagem). Qualquer falha devolve [] e a geração segue só com o texto. */
  private async loadReferences(urls: string[] | undefined): Promise<Array<{ blob: Blob; name: string }>> {
    const out: Array<{ blob: Blob; name: string }> = [];
    for (const u of (urls ?? []).slice(0, 3)) {
      try {
        const r = await this.f(u, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
        const mime = (r.headers.get('content-type') ?? '').split(';')[0]!.trim();
        if (!r.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) continue;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.byteLength > 8 * 1024 * 1024) continue;
        out.push({ blob: new Blob([bytes], { type: mime }), name: `ref${out.length}.${mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1]}` });
      } catch { /* sem referência */ }
    }
    return out;
  }

  async generateImage(req: { model: string; prompt: string } & GenerationParams): Promise<ImageResult> {
    // Com personagem: tenta /images/edits (a imagem de referência guia o resultado). Se o gateway não suportar, cai no texto.
    const refs = await this.loadReferences(req.referenceImageUrls);
    if (refs.length) {
      try {
        const form = new FormData();
        form.set('model', req.model);
        form.set('prompt', req.prompt);
        form.set('n', String(req.imageCount ?? 1));
        if (req.imageSize) form.set('size', req.imageSize);
        for (const r of refs) form.append('image[]', r.blob, r.name);
        const res = await this.request('POST', '/images/edits', undefined, { retries: 0, form });
        const parsed = await this.parseImages(res);
        return { ...parsed, referenceUsed: true };
      } catch (e) {
        // 4xx/5xx do /edits: segue só com o texto (a descrição do personagem já está no prompt)
        if (!(e instanceof ProviderError)) throw e;
      }
    }
    const res = await this.request('POST', '/images/generations', {
      model: req.model,
      prompt: req.prompt,
      n: req.imageCount ?? 1,
      ...(req.imageSize ? { size: req.imageSize } : {}),
    });
    return this.parseImages(res);
  }

  private async parseImages(res: Response): Promise<ImageResult> {
    const j = (await res.json().catch(() => null)) as any;
    const items: Array<Record<string, unknown>> = Array.isArray(j?.data) ? j.data : [];
    const images = items
      .map((i) => ({
        b64: typeof i.b64_json === 'string' ? i.b64_json : undefined,
        url: typeof i.url === 'string' ? i.url : undefined,
      }))
      .filter((i) => i.b64 || i.url);
    if (images.length === 0) throw new ProviderError('Resposta de imagens sem resultado.');
    return { images, requestId: res.headers.get('x-request-id') ?? undefined };
  }

  async generateSpeech(req: { model: string; input: string; voice?: string }): Promise<AudioResult> {
    const res = await this.request('POST', '/audio/speech', {
      model: req.model,
      input: req.input,
      voice: req.voice ?? 'alloy',
      response_format: 'mp3',
    });
    const audio = new Uint8Array(await res.arrayBuffer());
    if (audio.byteLength === 0) throw new ProviderError('Resposta de /audio/speech vazia.');
    return { audio, mimeType: 'audio/mpeg', requestId: res.headers.get('x-request-id') ?? undefined };
  }

  // ── HTTP ──────────────────────────────────────────────

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    opts: { retries?: number; timeoutMs?: number; form?: FormData } = {},
  ): Promise<Response> {
    const retries = opts.retries ?? this.retries;
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    let lastError: ProviderError | undefined;

    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.f(this.base + path, {
          method,
          headers: {
            Authorization: `Bearer ${this.key}`,
            Accept: 'application/json, audio/*',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          },
          body: opts.form ?? (body !== undefined ? JSON.stringify(body) : undefined),
          signal: AbortSignal.timeout(timeout),
          redirect: 'error', // nunca seguir redirect carregando a chave para outro host
        });
      } catch (e) {
        // Timeout/rede: a chamada pode ter sido processada → não repetir (evita cobrança dupla).
        const timedOut = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError';
        throw new ProviderError(
          timedOut ? `Tempo esgotado após ${Math.round(timeout / 1000)}s.` : `Falha de rede ao chamar o provedor: ${(e as Error).message}`,
        );
      }
      if (res.ok) return res;

      lastError = await toProviderError(res);
      if (!lastError.retryable) throw lastError;
    }
    throw lastError!;
  }
}

async function toProviderError(res: Response): Promise<ProviderError> {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      detail = String(j?.error?.message ?? j?.message ?? j?.detail ?? raw);
    } catch {
      detail = raw;
    }
  } catch {
    /* corpo ilegível */
  }
  detail = detail.replace(/\s+/g, ' ').slice(0, 300);
  const hint =
    res.status === 401 || res.status === 403
      ? ' (chave inválida ou sem permissão)'
      : res.status === 402
        ? ' (saldo/créditos insuficientes no provedor)'
        : res.status === 404
          ? ' (endpoint ou modelo não encontrado — confira a URL base)'
          : res.status === 429
            ? ' (limite de requisições)'
            : '';
  return new ProviderError(
    `Provedor respondeu HTTP ${res.status}${hint}${detail ? `: ${detail}` : ''}`,
    res.status,
    res.status === 429 || res.status === 503,
  );
}

const numOrUndef = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
