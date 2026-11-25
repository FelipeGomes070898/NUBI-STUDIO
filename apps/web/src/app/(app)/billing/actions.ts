'use server';
import { run } from '@/lib/action';
import { bool, money, str } from '@/lib/form';
import { UserError } from '@/server/errors';
import { adjustWallet, creditWallet, setClientBudget, updateWalletSettings } from '@/server/billing/wallet';

export async function creditAction(fd: FormData) {
  await run('/billing', async (ws) => {
    const v = money(fd, 'amount', 'Valor');
    if (!v) throw new UserError('Informe o valor do crédito.');
    await creditWallet(ws, v, str(fd, 'description') || 'Crédito registrado manualmente');
    return 'Crédito registrado.';
  });
}

export async function adjustAction(fd: FormData) {
  await run('/billing', async (ws) => {
    const raw = str(fd, 'amount').replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new UserError('Valor do ajuste inválido.');
    await adjustWallet(ws, raw, str(fd, 'description'));
    return 'Ajuste registrado.';
  });
}

export async function settingsAction(fd: FormData) {
  await run('/billing', async (ws) => {
    await updateWalletSettings(ws, { monthlyLimit: money(fd, 'monthlyLimit', 'Limite mensal'), allowUnpricedModels: bool(fd, 'allowUnpricedModels') });
    return 'Configurações da carteira salvas.';
  });
}

export async function clientBudgetAction(fd: FormData) {
  await run('/billing', async (ws) => {
    await setClientBudget(ws, str(fd, 'entityId'), money(fd, 'monthlyBudget', 'Orçamento'));
    return 'Orçamento do cliente atualizado.';
  });
}
