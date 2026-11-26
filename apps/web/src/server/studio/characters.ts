import { prisma, Prisma } from '@social-manager/db';
import { assertOwnBlobUrl } from '../blobUrl';
import { UserError } from '../errors';

export const MAX_REFERENCES = 3;

function clean(input: { name: string; description: string; referenceUrls: string[] }) {
  const name = input.name.trim();
  const description = input.description.trim();
  if (!name) throw new UserError('Informe o nome do personagem.');
  if (name.length > 80) throw new UserError('Nome do personagem muito longo (máx. 80).');
  if (description.length < 10) throw new UserError('Descreva o personagem (aparência, roupa, estilo): pelo menos 10 caracteres. É isso que mantém ele igual em todos os vídeos.');
  if (description.length > 2000) throw new UserError('A descrição passa de 2000 caracteres.');
  const urls = [...new Set(input.referenceUrls.map((u) => u.trim()).filter(Boolean))];
  if (urls.length > MAX_REFERENCES) throw new UserError(`No máximo ${MAX_REFERENCES} imagens de referência.`);
  urls.forEach((u) => assertOwnBlobUrl(u, 'imagem do personagem'));
  return { name, description, referenceUrls: urls };
}

async function dup<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new UserError('Já existe um personagem com esse nome.');
    throw e;
  }
}

export const createCharacter = (workspaceId: string, input: { name: string; description: string; referenceUrls: string[] }) =>
  dup(() => prisma.character.create({ data: { workspaceId, ...clean(input) } }));

export async function updateCharacter(workspaceId: string, id: string, input: { name: string; description: string; referenceUrls: string[] }) {
  const r = await dup(() => prisma.character.updateMany({ where: { id, workspaceId }, data: clean(input) }));
  if (r.count === 0) throw new UserError('Personagem não encontrado.');
}

/** Os grupos e projetos que usavam o personagem ficam sem personagem (nada é apagado). */
export async function deleteCharacter(workspaceId: string, id: string) {
  const r = await prisma.character.deleteMany({ where: { id, workspaceId } });
  if (r.count === 0) throw new UserError('Personagem não encontrado.');
}

/** Personagem FIXO do grupo: vale para todos os vídeos criados para ele (pode ser trocado na hora). null remove. */
export async function setGroupCharacter(workspaceId: string, groupId: string, characterId: string | null) {
  if (characterId && !(await prisma.character.count({ where: { id: characterId, workspaceId } }))) throw new UserError('Personagem não encontrado.');
  const r = await prisma.accountGroup.updateMany({ where: { id: groupId, workspaceId }, data: { characterId } });
  if (r.count === 0) throw new UserError('Grupo não encontrado.');
}

export const listCharacters = (workspaceId: string) =>
  prisma.character.findMany({ where: { workspaceId }, orderBy: { name: 'asc' }, include: { groups: { select: { id: true, name: true } }, _count: { select: { projects: true } } } });
