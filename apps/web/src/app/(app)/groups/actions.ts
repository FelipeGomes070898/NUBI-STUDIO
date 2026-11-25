'use server';
import { run } from '@/lib/action';
import { bool, oneOf, optStr, str } from '@/lib/form';
import { FORMATS } from '@/lib/labels';
import { createGroup, deleteGroup, setGroupMembers, updateGroup } from '@/server/directory';

export async function createGroupAction(fd: FormData) {
  await run('/groups', async (ws) => {
    const g = await createGroup(ws, {
      name: str(fd, 'name'),
      description: optStr(fd, 'description'),
      defaultFormat: oneOf(fd, 'defaultFormat', FORMATS, 'Formato'),
      clientId: optStr(fd, 'clientId'),
    });
    return { message: 'Grupo criado. Agora escolha as contas.', to: `/groups/${g.id}` };
  });
}

export async function saveGroupAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/groups/${id}`, async (ws) => {
    await updateGroup(ws, id, {
      name: str(fd, 'name'),
      description: optStr(fd, 'description'),
      defaultFormat: oneOf(fd, 'defaultFormat', FORMATS, 'Formato'),
      clientId: optStr(fd, 'clientId'),
      isActive: bool(fd, 'isActive'),
    });
    return 'Grupo salvo.';
  });
}

export async function saveMembersAction(fd: FormData) {
  const id = str(fd, 'entityId');
  await run(`/groups/${id}`, async (ws) => {
    await setGroupMembers(ws, id, fd.getAll('accountIds').map(String));
    return 'Contas do grupo atualizadas.';
  });
}

export async function deleteGroupAction(fd: FormData) {
  await run('/groups', async (ws) => {
    await deleteGroup(ws, str(fd, 'entityId'));
    return 'Grupo excluído (as contas continuam cadastradas).';
  });
}
