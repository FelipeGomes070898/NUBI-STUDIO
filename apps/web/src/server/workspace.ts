import { prisma } from '@social-manager/db';

/**
 * Esta fase roda em modo workspace único (o schema já é multi-workspace e todas as consultas filtram por
 * workspaceId). Id fixo → criação idempotente e sem corrida entre requisições simultâneas.
 */
export const DEFAULT_WORKSPACE_ID = 'ws_default';

export async function getWorkspace() {
  return prisma.workspace.upsert({
    where: { id: DEFAULT_WORKSPACE_ID },
    update: {},
    create: { id: DEFAULT_WORKSPACE_ID, name: 'Meu workspace', wallet: { create: {} } },
  });
}
