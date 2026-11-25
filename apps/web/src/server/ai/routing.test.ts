import { describe, expect, it } from 'vitest';
import { planRoute, RoutingError, type RoutableModel, type RoutableProvider } from './routing';

const prov = (id: string, o: Partial<RoutableProvider> = {}): RoutableProvider => ({ id, name: id, adapter: 'OPENAI_COMPATIBLE', isActive: true, isPrimary: false, ...o });
const mod = (id: string, providerId: string, o: Partial<RoutableModel> = {}): RoutableModel => ({
  id, providerId, providerModelId: id, displayName: id, modalities: ['TEXT'], pricing: { inputPerMTok: 1, outputPerMTok: 1 }, isActive: true, ...o,
});
const base = { task: 'SCRIPT' as const, request: { prompt: 'oi', params: {} }, preference: null, isSupported: (a: string, m: string) => m !== 'VIDEO' };

describe('planRoute', () => {
  it('AUTO sem preferência: provedor principal primeiro, depois menor custo, sem preço por último', () => {
    const plan = planRoute({
      ...base,
      providers: [prov('p1'), prov('p2', { isPrimary: true })],
      models: [
        mod('caro-p1', 'p1', { pricing: { inputPerMTok: 10, outputPerMTok: 10 } }),
        mod('barato-p1', 'p1', { pricing: { inputPerMTok: 1, outputPerMTok: 1 } }),
        mod('sem-preco-p2', 'p2', { pricing: null }),
        mod('medio-p2', 'p2', { pricing: { inputPerMTok: 5, outputPerMTok: 5 } }),
      ],
    });
    expect(plan.selectionMode).toBe('AUTO');
    expect(plan.entries.map((e) => e.model.id)).toEqual(['medio-p2', 'sem-preco-p2', 'barato-p1', 'caro-p1']);
  });

  it('ignora modelos inativos, de provedor inativo e de outra modalidade', () => {
    const plan = planRoute({
      ...base,
      providers: [prov('p1'), prov('off', { isActive: false })],
      models: [mod('ok', 'p1'), mod('inativo', 'p1', { isActive: false }), mod('imagem', 'p1', { modalities: ['IMAGE'] }), mod('deprov', 'off')],
    });
    expect(plan.entries.map((e) => e.model.id)).toEqual(['ok']);
  });

  it('erra com mensagem acionável quando não há candidato', () => {
    expect(() => planRoute({ ...base, providers: [prov('p1')], models: [] })).toThrow(RoutingError);
    expect(() => planRoute({ ...base, providers: [prov('p1')], models: [] })).toThrow(/sincronize/i);
  });

  it('AUTO com preferência usa modelo preferido e alternativas aprovadas, nessa ordem', () => {
    const plan = planRoute({
      ...base,
      providers: [prov('p1', { isPrimary: true })],
      models: [mod('a', 'p1'), mod('b', 'p1'), mod('c', 'p1')],
      preference: { mode: 'AUTO', modelId: 'b', fallbackModelIds: ['c'] },
    });
    expect(plan.entries.map((e) => e.model.id)).toEqual(['b', 'c']); // 'a' não foi aprovado
  });

  it('AUTO cai no pool geral se o preferido ficou indisponível', () => {
    const plan = planRoute({
      ...base,
      providers: [prov('p1')],
      models: [mod('a', 'p1'), mod('b', 'p1', { isActive: false })],
      preference: { mode: 'AUTO', modelId: 'b', fallbackModelIds: [] },
    });
    expect(plan.entries.map((e) => e.model.id)).toEqual(['a']);
    expect(plan.reason).toMatch(/indisponível/);
  });

  it('MANUAL da tarefa: não troca para modelo não aprovado', () => {
    const args = { ...base, providers: [prov('p1')], models: [mod('a', 'p1'), mod('b', 'p1', { isActive: false })] };
    expect(() => planRoute({ ...args, preference: { mode: 'MANUAL', modelId: 'b', fallbackModelIds: [] } })).toThrow(/indispon/);
    expect(() => planRoute({ ...args, preference: { mode: 'MANUAL', modelId: null, fallbackModelIds: [] } })).toThrow(/sem modelo definido/);
    const ok = planRoute({ ...args, preference: { mode: 'MANUAL', modelId: 'a', fallbackModelIds: [] } });
    expect(ok.selectionMode).toBe('MANUAL');
  });

  it('escolha explícita vence a preferência e nunca tem fallback', () => {
    const plan = planRoute({
      ...base,
      providers: [prov('p1')],
      models: [mod('a', 'p1'), mod('b', 'p1')],
      preference: { mode: 'AUTO', modelId: 'a', fallbackModelIds: ['b'] },
      requestedModelId: 'b',
    });
    expect(plan.entries.map((e) => e.model.id)).toEqual(['b']);
    expect(plan.selectionMode).toBe('MANUAL');
    expect(() => planRoute({ ...base, providers: [prov('p1')], models: [mod('a', 'p1', { isActive: false })], requestedModelId: 'a' })).toThrow(/desativado/);
    expect(() => planRoute({ ...base, providers: [prov('p1')], models: [mod('a', 'p1')], requestedModelId: 'a', task: 'IMAGE' })).toThrow(/IMAGE/);
  });

  it('modalidade sem suporte no adapter (vídeo) é recusada com explicação', () => {
    expect(() =>
      planRoute({ ...base, task: 'VIDEO', providers: [prov('p1')], models: [mod('v', 'p1', { modalities: ['VIDEO'] })], requestedModelId: 'v' }),
    ).toThrow(/suporte pendente/);
  });
});
