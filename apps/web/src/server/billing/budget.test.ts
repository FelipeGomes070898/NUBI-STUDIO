import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkBudget, monthStartUTC, type BudgetSnapshot } from './budget';

const d = (n: number | string) => new Decimal(n);
const snap = (o: Partial<BudgetSnapshot> = {}): BudgetSnapshot => ({
  balance: d(10), reserved: d(0), monthlyLimit: null, monthSpent: d(0), allowUnpriced: false, client: null, ...o,
});

describe('checkBudget', () => {
  it('aprova e reserva o estimado quando tudo cabe', () => {
    const v = checkBudget(d(1), snap());
    expect(v).toEqual({ ok: true, reserve: d(1) });
  });
  it('desconta o já reservado do saldo livre', () => {
    expect(checkBudget(d(3), snap({ balance: d(10), reserved: d(8) })).ok).toBe(false);
    expect(checkBudget(d(2), snap({ balance: d(10), reserved: d(8) })).ok).toBe(true);
  });
  it('bloqueia pelo limite mensal global somando gasto + retido + estimado', () => {
    const v = checkBudget(d(2), snap({ monthlyLimit: d(5), monthSpent: d(2), reserved: d(1.5) }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/Limite mensal da carteira/);
    expect(checkBudget(d(1.5), snap({ monthlyLimit: d(5), monthSpent: d(2), reserved: d(1.5) })).ok).toBe(true);
  });
  it('bloqueia pelo orçamento do cliente mesmo com saldo sobrando', () => {
    const client = { name: 'ACME', monthlyBudget: d(1), monthSpent: d('0.8'), reserved: d(0) };
    const v = checkBudget(d('0.3'), snap({ client }));
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/ACME/);
    expect(checkBudget(d('0.2'), snap({ client })).ok).toBe(true);
  });
  it('cliente sem orçamento próprio só obedece à carteira', () => {
    expect(checkBudget(d(1), snap({ client: { name: 'X', monthlyBudget: null, monthSpent: d(999), reserved: d(0) } })).ok).toBe(true);
  });
  it('modelo sem preço: bloqueia por padrão, libera se permitido (sem reservar)', () => {
    const blocked = checkBudget(null, snap());
    expect(!blocked.ok && blocked.reason).toMatch(/preço/);
    expect(checkBudget(null, snap({ allowUnpriced: true }))).toEqual({ ok: true, reserve: d(0) });
  });
});

describe('monthStartUTC', () => {
  it('é o dia 1 às 00:00 UTC', () => {
    expect(monthStartUTC(new Date('2026-03-31T23:59:59Z')).toISOString()).toBe('2026-03-01T00:00:00.000Z');
  });
});
