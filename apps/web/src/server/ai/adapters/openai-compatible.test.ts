import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../types';
import { OpenAICompatibleAdapter } from './openai-compatible';

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const make = (f: typeof fetch, o: Partial<ConstructorParameters<typeof OpenAICompatibleAdapter>[0]> = {}) =>
  new OpenAICompatibleAdapter({ baseUrl: 'https://gw.test/v1/', apiKey: 'sk-test-1234', fetch: f, retryDelayMs: 1, ...o });

describe('OpenAICompatibleAdapter', () => {
  it('envia a chave só no header e normaliza a URL base', async () => {
    const f = vi.fn(async () => json({ data: [{ id: 'gpt-x' }] }));
    await make(f as unknown as typeof fetch).listModels();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gw.test/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-1234');
    expect(init.redirect).toBe('error');
  });

  it('lista modelos inferindo modalidade e lendo preço do catálogo', async () => {
    const f = async () =>
      json({
        data: [
          { id: 'openai/gpt-5', name: 'GPT 5', pricing: { prompt: '0.000003', completion: '0.000015' } },
          { id: 'google/veo-3' },
          { id: 'openai/gpt-image-1' },
          { id: 'x/tts-1' },
          { id: 'a/b', architecture: { output_modalities: ['text', 'image'] } },
          { id: 'openai/gpt-5' },
        ],
      });
    const m = await make(f as unknown as typeof fetch).listModels();
    expect(m).toHaveLength(5); // duplicata removida
    expect(m[0]).toMatchObject({ providerModelId: 'openai/gpt-5', displayName: 'GPT 5', modalities: ['TEXT'] });
    expect(m[0]!.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15 });
    expect(m.map((x) => x.modalities[0])).toEqual(['TEXT', 'VIDEO', 'IMAGE', 'AUDIO', 'TEXT']);
    expect(m[4]!.modalities).toEqual(['TEXT', 'IMAGE']);
  });

  it('gera texto lendo uso e custo informado', async () => {
    const f = vi.fn(async () => json({ id: 'req1', choices: [{ message: { content: 'Olá!' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0004 } }));
    const r = await make(f as unknown as typeof fetch).generateText({ model: 'm', prompt: 'oi', system: 'sys', maxOutputTokens: 50 });
    expect(r).toEqual({ text: 'Olá!', inputTokens: 10, outputTokens: 5, reportedCost: 0.0004, requestId: 'req1' });
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ model: 'm', max_tokens: 50, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'oi' }] });
  });

  it('gera imagem (b64 ou url) e áudio', async () => {
    const img = await make((async () => json({ data: [{ b64_json: 'QUJD' }] })) as unknown as typeof fetch).generateImage({ model: 'm', prompt: 'p' });
    expect(img.images[0]).toEqual({ b64: 'QUJD', url: undefined });
    const au = await make((async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch).generateSpeech({ model: 'm', input: 'x' });
    expect(Array.from(au.audio)).toEqual([1, 2, 3]);
  });

  it('401 não repete e a mensagem não vaza a chave', async () => {
    const f = vi.fn(async () => json({ error: { message: 'bad key sk-test-1234' } }, { status: 401 }));
    const err = await make(f as unknown as typeof fetch).generateText({ model: 'm', prompt: 'p' }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/chave inválida/);
  });

  it('repete 429 com backoff e depois funciona', async () => {
    let n = 0;
    const f = vi.fn(async () => (++n < 3 ? json({ error: { message: 'slow down' } }, { status: 429 }) : json({ choices: [{ message: { content: 'ok' } }] })));
    const r = await make(f as unknown as typeof fetch).generateText({ model: 'm', prompt: 'p' });
    expect(r.text).toBe('ok');
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('desiste do 429 após as tentativas e NÃO repete falha de rede (evita cobrança dupla)', async () => {
    const f429 = vi.fn(async () => json({}, { status: 429 }));
    await expect(make(f429 as unknown as typeof fetch, { retries: 1 }).generateText({ model: 'm', prompt: 'p' })).rejects.toThrow(/429/);
    expect(f429).toHaveBeenCalledTimes(2);
    const fNet = vi.fn(async () => { throw new TypeError('socket hang up'); });
    await expect(make(fNet as unknown as typeof fetch).generateImage({ model: 'm', prompt: 'p' })).rejects.toThrow(/rede/);
    expect(fNet).toHaveBeenCalledTimes(1);
  });

  it('healthCheck devolve ok/erro sem lançar', async () => {
    expect((await make((async () => json({ data: [] })) as unknown as typeof fetch).healthCheck()).ok).toBe(true);
    const bad = await make((async () => json({}, { status: 404 })) as unknown as typeof fetch).healthCheck();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/URL base/);
  });
});
