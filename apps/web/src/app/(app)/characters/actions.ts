'use server';
import { redirect } from 'next/navigation';
import { run } from '@/lib/action';
import { requireSession } from '@/lib/auth';
import { str } from '@/lib/form';
import { userMessage } from '@/server/errors';
import { createCharacter, deleteCharacter, updateCharacter } from '@/server/studio/characters';
import { getWorkspace } from '@/server/workspace';

export type CharacterState = { error?: string };

/** Cria ou atualiza (se vier `entityId`). Devolve o erro para o formulário manter o que foi digitado. */
export async function saveCharacterAction(_prev: CharacterState, fd: FormData): Promise<CharacterState> {
  await requireSession();
  try {
    const ws = await getWorkspace();
    const data = { name: str(fd, 'name'), description: str(fd, 'description'), referenceUrls: fd.getAll('referenceUrls').map(String) };
    const id = str(fd, 'entityId');
    if (id) await updateCharacter(ws.id, id, data);
    else await createCharacter(ws.id, data);
  } catch (e) {
    return { error: userMessage(e) };
  }
  redirect(`/characters?ok=${encodeURIComponent(str(fd, 'entityId') ? 'Personagem atualizado.' : 'Personagem criado. Agora fixe-o em um grupo.')}`);
}

export async function deleteCharacterAction(fd: FormData) {
  await run('/characters', async (ws) => {
    await deleteCharacter(ws, str(fd, 'entityId'));
    return 'Personagem excluído (grupos e vídeos que o usavam ficam sem personagem).';
  });
}
