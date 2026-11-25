import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { computeTextCost, estimateCost, parsePricing, usd } from './pricing';

describe('estimateCost', () => {
  it('texto: entrada estimada + teto de saída', () => {
    // prompt de 300 chars ≈ 100 tokens; saída 1000 tokens. (100*3 + 1000*15)/1e6
    const c = estimateCost({ inputPerMTok: 3, outputPerMTok: 15 }, 'TEXT', { prompt: 'a'.repeat(300), params: { maxOutputTokens: 1000 } });
    expect(c!.toString()).toBe('0.0153');
  });
  it('texto sem preço de saída ou sem pricing → null (não controlável)', () => {
    expect(estimateCost({ inputPerMTok: 3 }, 'TEXT', { prompt: 'x', params: {} })).toBeNull();
    expect(estimateCost(null, 'TEXT', { prompt: 'x', params: {} })).toBeNull();
  });
  it('imagem: por imagem × quantidade + fixo', () => {
    expect(estimateCost({ perImage: 0.04, perRequest: 0.01 }, 'IMAGE', { prompt: 'x', params: { imageCount: 2 } })!.toString()).toBe('0.09');
  });
  it('vídeo: por segundo (padrão 5s)', () => {
    expect(estimateCost({ perSecond: 0.5 }, 'VIDEO', { prompt: 'x', params: {} })!.toString()).toBe('2.5');
    expect(estimateCost({ perSecond: 0.5 }, 'VIDEO', { prompt: 'x', params: { durationSec: 8 } })!.toString()).toBe('4');
  });
  it('áudio: por milhão de caracteres', () => {
    expect(estimateCost({ perMChar: 15 }, 'AUDIO', { prompt: 'a'.repeat(1000), params: {} })!.toString()).toBe('0.015');
  });
  it('preço de outra modalidade não se aplica', () => {
    expect(estimateCost({ perImage: 0.04 }, 'TEXT', { prompt: 'x', params: {} })).toBeNull();
    expect(estimateCost({ inputPerMTok: 1, outputPerMTok: 1 }, 'IMAGE', { prompt: 'x', params: {} })).toBeNull();
  });
});

describe('computeTextCost', () => {
  const p = { inputPerMTok: 3, outputPerMTok: 15 };
  it('usa o uso real', () => {
    expect(computeTextCost(p, { inputTokens: 1000, outputTokens: 200 }, new Decimal(1)).toString()).toBe('0.006');
  });
  it('sem uso informado, cai no teto estimado', () => {
    expect(computeTextCost(p, {}, new Decimal('0.5')).toString()).toBe('0.5');
  });
});

describe('parsePricing', () => {
  it('descarta lixo e valores negativos', () => {
    expect(parsePricing({ perImage: -1, foo: 3, inputPerMTok: 'x' })).toBeNull();
    expect(parsePricing({ perImage: 0.04, perSecond: NaN })).toEqual({ perImage: 0.04 });
    expect(parsePricing(null)).toBeNull();
  });
});

describe('usd', () => {
  it('formata frações pequenas sem arredondar para zero', () => {
    expect(usd(0.000123)).toBe('$0.000123');
    expect(usd(12.5)).toBe('$12.5000');
    expect(usd(0)).toBe('$0.0000');
  });
});
