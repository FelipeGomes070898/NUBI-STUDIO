import Decimal from 'decimal.js';
import { Prisma, prisma, type LedgerType } from '@social-manager/db';
import { UserError } from '../errors';
import { monthStartUTC } from './budget';

export type Tx = Prisma.TransactionClient;

export const dec = (v: { toString(): string } | null | undefined): Decimal => new Decimal(v?.toString() ?? 0);

/**
 * Serializa toda mutação financeira do workspace (reserva, liquidação, crédito).
 * Sem isso, duas gerações simultâneas poderiam ler o mesmo saldo livre e estourar o orçamento.
 */
export async function lockWallet(tx: Tx, workspaceId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Wallet" WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  if (rows.length === 0) throw new Error(`Carteira do workspace ${workspaceId} não existe.`);
}

/** Lançamento + atualização de saldo na mesma transação (chamar após lockWallet). */
export async function postLedger(
  tx: Tx,
  e: { workspaceId: string; clientId?: string | null; aiJobId?: string; type: LedgerType; amount: Decimal; description: string },
) {
  const delta = e.type === 'CREDIT' ? e.amount : e.type === 'DEBIT' ? e.amount.neg() : e.amount;
  const wallet = await tx.wallet.update({
    where: { workspaceId: e.workspaceId },
    data: { balance: { increment: delta.toString() } },
  });
  return tx.usageLedger.create({
    data: {
      workspaceId: e.workspaceId,
      clientId: e.clientId ?? null,
      aiJobId: e.aiJobId,
      type: e.type,
      amount: e.amount.toString(),
      balanceAfter: wallet.balance,
      description: e.description,
    },
  });
}

const positive = (v: Decimal.Value, what: string) => {
  const d = new Decimal(v);
  if (!d.isFinite() || d.lte(0)) throw new UserError(`${what} deve ser maior que zero.`);
  if (d.gt(1_000_000)) throw new UserError(`${what} acima do máximo permitido.`);
  return d;
};

export async function creditWallet(workspaceId: string, amount: Decimal.Value, description: string) {
  const value = positive(amount, 'O valor do crédito');
  await prisma.$transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    await postLedger(tx, { workspaceId, type: 'CREDIT', amount: value, description: description || 'Crédito registrado' });
  });
}

/** Correção manual do saldo (valor com sinal). Exige justificativa para auditoria. */
export async function adjustWallet(workspaceId: string, amount: Decimal.Value, description: string) {
  const value = new Decimal(amount);
  if (!value.isFinite() || value.isZero()) throw new UserError('O ajuste não pode ser zero.');
  if (!description.trim()) throw new UserError('Informe o motivo do ajuste.');
  await prisma.$transaction(async (tx) => {
    await lockWallet(tx, workspaceId);
    await postLedger(tx, { workspaceId, type: 'ADJUSTMENT', amount: value, description: description.trim() });
  });
}

export async function updateWalletSettings(
  workspaceId: string,
  s: { monthlyLimit: Decimal.Value | null; allowUnpricedModels: boolean },
) {
  if (s.monthlyLimit !== null && new Decimal(s.monthlyLimit).lt(0)) throw new UserError('O limite mensal não pode ser negativo.');
  await prisma.wallet.update({
    where: { workspaceId },
    data: { monthlyLimit: s.monthlyLimit === null ? null : new Decimal(s.monthlyLimit).toString(), allowUnpricedModels: s.allowUnpricedModels },
  });
}

export async function setClientBudget(workspaceId: string, clientId: string, monthlyBudget: Decimal.Value | null) {
  if (monthlyBudget !== null && new Decimal(monthlyBudget).lt(0)) throw new UserError('O orçamento não pode ser negativo.');
  const r = await prisma.client.updateMany({
    where: { id: clientId, workspaceId },
    data: { monthlyBudget: monthlyBudget === null ? null : new Decimal(monthlyBudget).toString() },
  });
  if (r.count === 0) throw new UserError('Cliente não encontrado.');
}

/** Retorna as somas de gasto confirmado e valor retido, no workspace e por cliente (mês corrente UTC). */
export async function readSpend(tx: Tx | typeof prisma, workspaceId: string, clientId?: string | null) {
  const since = monthStartUTC();
  const [wsSpent, wsReserved, clSpent, clReserved] = await Promise.all([
    tx.usageLedger.aggregate({ where: { workspaceId, type: 'DEBIT', createdAt: { gte: since } }, _sum: { amount: true } }),
    tx.aIJob.aggregate({ where: { workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, _sum: { reservedAmount: true } }),
    clientId
      ? tx.usageLedger.aggregate({ where: { workspaceId, clientId, type: 'DEBIT', createdAt: { gte: since } }, _sum: { amount: true } })
      : null,
    clientId
      ? tx.aIJob.aggregate({ where: { workspaceId, clientId, status: { in: ['QUEUED', 'RUNNING'] } }, _sum: { reservedAmount: true } })
      : null,
  ]);
  return {
    monthSpent: dec(wsSpent._sum.amount),
    reserved: dec(wsReserved._sum.reservedAmount),
    clientMonthSpent: dec(clSpent?._sum.amount),
    clientReserved: dec(clReserved?._sum.reservedAmount),
  };
}

export async function getFinanceOverview(workspaceId: string) {
  const [wallet, clients, ledger, spend] = await Promise.all([
    prisma.wallet.findUniqueOrThrow({ where: { workspaceId } }),
    prisma.client.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }),
    prisma.usageLedger.findMany({ where: { workspaceId }, orderBy: { createdAt: 'desc' }, take: 50, include: { client: { select: { name: true } } } }),
    readSpend(prisma, workspaceId),
  ]);
  const since = monthStartUTC();
  const perClient = await prisma.usageLedger.groupBy({
    by: ['clientId'],
    where: { workspaceId, type: 'DEBIT', createdAt: { gte: since } },
    _sum: { amount: true },
  });
  const spentByClient = new Map(perClient.map((r) => [r.clientId, dec(r._sum.amount)]));
  return {
    wallet,
    balance: dec(wallet.balance),
    reserved: spend.reserved,
    monthSpent: spend.monthSpent,
    unassignedSpent: spentByClient.get(null) ?? new Decimal(0),
    clients: clients.map((c) => ({ ...c, monthSpent: spentByClient.get(c.id) ?? new Decimal(0) })),
    ledger,
  };
}
