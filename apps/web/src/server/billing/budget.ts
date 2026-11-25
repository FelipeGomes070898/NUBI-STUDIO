import Decimal from 'decimal.js';
import { usd } from '../ai/pricing';

export interface BudgetSnapshot {
  /** Saldo confirmado da carteira. */
  balance: Decimal;
  /** Soma retida por jobs em andamento (workspace inteiro). */
  reserved: Decimal;
  /** Limite mensal global; null = sem limite. */
  monthlyLimit: Decimal | null;
  /** Débitos confirmados no mês corrente (workspace inteiro). */
  monthSpent: Decimal;
  allowUnpriced: boolean;
  client: null | {
    name: string;
    monthlyBudget: Decimal | null;
    monthSpent: Decimal;
    reserved: Decimal;
  };
}

export type BudgetVerdict = { ok: true; reserve: Decimal } | { ok: false; reason: string };

/**
 * Decide se uma geração com custo máximo `estimate` cabe nas regras da carteira.
 * Regras (todas precisam passar): saldo livre → limite mensal global → orçamento mensal do cliente.
 * Estimativa é limite superior reservado, não cobrança final.
 */
export function checkBudget(estimate: Decimal | null, s: BudgetSnapshot): BudgetVerdict {
  if (estimate === null) {
    return s.allowUnpriced
      ? { ok: true, reserve: new Decimal(0) }
      : {
          ok: false,
          reason:
            'Este modelo não tem preço cadastrado, então o custo não pode ser controlado. ' +
            'Informe o preço em Central de IA → Modelos (ou permita modelos sem preço em Custos).',
        };
  }

  const free = s.balance.sub(s.reserved);
  if (free.lt(estimate)) {
    return {
      ok: false,
      reason: `Saldo insuficiente na carteira: disponível ${usd(free)}, necessário até ${usd(estimate)}.`,
    };
  }

  if (s.monthlyLimit && s.monthSpent.add(s.reserved).add(estimate).gt(s.monthlyLimit)) {
    return {
      ok: false,
      reason: `Limite mensal da carteira (${usd(s.monthlyLimit)}) seria excedido: já consumido/retido ${usd(
        s.monthSpent.add(s.reserved),
      )}, esta geração pode custar até ${usd(estimate)}.`,
    };
  }

  const c = s.client;
  if (c?.monthlyBudget && c.monthSpent.add(c.reserved).add(estimate).gt(c.monthlyBudget)) {
    return {
      ok: false,
      reason: `Orçamento mensal do cliente "${c.name}" (${usd(c.monthlyBudget)}) seria excedido: já consumido/retido ${usd(
        c.monthSpent.add(c.reserved),
      )}, esta geração pode custar até ${usd(estimate)}.`,
    };
  }

  return { ok: true, reserve: estimate };
}

/** Início do mês corrente em UTC (janela dos limites mensais). */
export function monthStartUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
