'use server';
import { run } from '@/lib/action';
import { bool, oneOf, optStr, str } from '@/lib/form';
import { PLATFORMS } from '@/lib/labels';
import { createAccount, deleteAccount, setAccountActive } from '@/server/directory';

export async function createAccountAction(fd: FormData) {
  await run('/accounts', async (ws) => {
    await createAccount(ws, {
      platform: oneOf(fd, 'platform', PLATFORMS, 'Plataforma'),
      displayName: str(fd, 'displayName'),
      handle: optStr(fd, 'handle'),
      clientId: optStr(fd, 'clientId'),
    });
    return 'Conta cadastrada.';
  });
}

export async function toggleAccountAction(fd: FormData) {
  await run('/accounts', async (ws) => {
    await setAccountActive(ws, str(fd, 'entityId'), bool(fd, 'active'));
    return 'Conta atualizada.';
  });
}

export async function deleteAccountAction(fd: FormData) {
  await run('/accounts', async (ws) => {
    await deleteAccount(ws, str(fd, 'entityId'));
    return 'Conta excluída.';
  });
}
