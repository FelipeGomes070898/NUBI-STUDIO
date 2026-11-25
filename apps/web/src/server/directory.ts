import { prisma, Prisma, type SocialPlatform, type VideoFormat } from '@social-manager/db';
import { UserError } from './errors';

/** Traduz violação de unicidade em mensagem clara. */
async function dupAware<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new UserError(`${what} já existe.`);
    throw e;
  }
}

const name = (v: string, label: string) => {
  const t = v.trim();
  if (!t) throw new UserError(`Informe ${label}.`);
  if (t.length > 120) throw new UserError(`${label[0]!.toUpperCase()}${label.slice(1)} muito longo (máx. 120).`);
  return t;
};

// ── Clientes ──────────────────────────────────────────────

export const createClient = (workspaceId: string, i: { name: string; notes?: string; monthlyBudget?: string | null }) =>
  dupAware('Um cliente com esse nome', () =>
    prisma.client.create({
      data: { workspaceId, name: name(i.name, 'o nome do cliente'), notes: i.notes?.trim() || null, monthlyBudget: i.monthlyBudget ?? null },
    }),
  );

export async function setClientActive(workspaceId: string, id: string, isActive: boolean) {
  const r = await prisma.client.updateMany({ where: { id, workspaceId }, data: { isActive } });
  if (r.count === 0) throw new UserError('Cliente não encontrado.');
}

export async function deleteClient(workspaceId: string, id: string) {
  const used = await prisma.aIJob.count({ where: { workspaceId, clientId: id } });
  if (used > 0) throw new UserError('Este cliente tem histórico de consumo de IA. Desative-o em vez de excluir.');
  const r = await prisma.client.deleteMany({ where: { id, workspaceId } });
  if (r.count === 0) throw new UserError('Cliente não encontrado.');
}

// ── Contas sociais ────────────────────────────────────────

export const createAccount = (
  workspaceId: string,
  i: { platform: SocialPlatform; displayName: string; handle?: string; clientId?: string | null },
) =>
  dupAware(`Uma conta ${i.platform} com esse nome`, async () => {
    if (i.clientId && !(await prisma.client.count({ where: { id: i.clientId, workspaceId } }))) throw new UserError('Cliente não encontrado.');
    return prisma.socialAccount.create({
      data: {
        workspaceId,
        platform: i.platform,
        displayName: name(i.displayName, 'o nome da conta'),
        handle: i.handle?.trim() || null,
        clientId: i.clientId || null,
      },
    });
  });

export async function setAccountActive(workspaceId: string, id: string, isActive: boolean) {
  const r = await prisma.socialAccount.updateMany({ where: { id, workspaceId }, data: { isActive } });
  if (r.count === 0) throw new UserError('Conta não encontrada.');
}

export async function deleteAccount(workspaceId: string, id: string) {
  if (await prisma.publicationTarget.count({ where: { socialAccountId: id, account: { workspaceId } } }))
    throw new UserError('Esta conta tem publicações no histórico. Desative-a em vez de excluir.');
  const r = await prisma.socialAccount.deleteMany({ where: { id, workspaceId } });
  if (r.count === 0) throw new UserError('Conta não encontrada.');
}

// ── Grupos ────────────────────────────────────────────────

export const createGroup = (
  workspaceId: string,
  i: { name: string; description?: string; defaultFormat: VideoFormat; clientId?: string | null },
) =>
  dupAware('Um grupo com esse nome', async () => {
    if (i.clientId && !(await prisma.client.count({ where: { id: i.clientId, workspaceId } }))) throw new UserError('Cliente não encontrado.');
    return prisma.accountGroup.create({
      data: {
        workspaceId,
        name: name(i.name, 'o nome do grupo'),
        description: i.description?.trim() || null,
        defaultFormat: i.defaultFormat,
        clientId: i.clientId || null,
      },
    });
  });

export const updateGroup = (
  workspaceId: string,
  id: string,
  i: { name: string; description?: string; defaultFormat: VideoFormat; clientId?: string | null; isActive: boolean },
) =>
  dupAware('Um grupo com esse nome', async () => {
    if (i.clientId && !(await prisma.client.count({ where: { id: i.clientId, workspaceId } }))) throw new UserError('Cliente não encontrado.');
    const r = await prisma.accountGroup.updateMany({
      where: { id, workspaceId },
      data: { name: name(i.name, 'o nome do grupo'), description: i.description?.trim() || null, defaultFormat: i.defaultFormat, clientId: i.clientId || null, isActive: i.isActive },
    });
    if (r.count === 0) throw new UserError('Grupo não encontrado.');
  });

export async function deleteGroup(workspaceId: string, id: string) {
  const r = await prisma.accountGroup.deleteMany({ where: { id, workspaceId } }); // memberships em cascata; as contas permanecem
  if (r.count === 0) throw new UserError('Grupo não encontrado.');
}

/** Define exatamente quais contas pertencem ao grupo (uma conta pode estar em vários grupos). */
export async function setGroupMembers(workspaceId: string, groupId: string, accountIds: string[]) {
  const unique = [...new Set(accountIds)];
  await prisma.$transaction(async (tx) => {
    if (!(await tx.accountGroup.count({ where: { id: groupId, workspaceId } }))) throw new UserError('Grupo não encontrado.');
    if ((await tx.socialAccount.count({ where: { id: { in: unique }, workspaceId } })) !== unique.length) throw new UserError('Alguma conta selecionada não existe.');
    await tx.groupMembership.deleteMany({ where: { groupId, socialAccountId: { notIn: unique } } });
    await tx.groupMembership.createMany({ data: unique.map((socialAccountId) => ({ groupId, socialAccountId })), skipDuplicates: true });
  });
}

export function listGroups(workspaceId: string) {
  return prisma.accountGroup.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
    include: { client: { select: { name: true } }, memberships: { include: { account: true } } },
  });
}
