'use server';
import { run } from '@/lib/action';
import { bool, money, optStr, str } from '@/lib/form';
import { createClient, deleteClient, setClientActive } from '@/server/directory';
import { setClientBudget } from '@/server/billing/wallet';

export async function createClientAction(fd: FormData) {
  await run('/clients', async (ws) => {
    await createClient(ws, { name: str(fd, 'name'), notes: optStr(fd, 'notes'), monthlyBudget: money(fd, 'monthlyBudget', 'Orçamento')?.toString() ?? null });
    return 'Cliente criado.';
  });
}

export async function toggleClientAction(fd: FormData) {
  await run('/clients', async (ws) => {
    await setClientActive(ws, str(fd, 'entityId'), bool(fd, 'active'));
    return 'Cliente atualizado.';
  });
}

export async function budgetAction(fd: FormData) {
  await run('/clients', async (ws) => {
    await setClientBudget(ws, str(fd, 'entityId'), money(fd, 'monthlyBudget', 'Orçamento'));
    return 'Orçamento atualizado.';
  });
}

export async function deleteClientAction(fd: FormData) {
  await run('/clients', async (ws) => {
    await deleteClient(ws, str(fd, 'entityId'));
    return 'Cliente excluído.';
  });
}
