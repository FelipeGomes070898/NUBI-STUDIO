/**
 * Dados de EXEMPLO (idempotente) baseados nos casos de uso do projeto:
 *  - Luciano ZEEN: 3 páginas Facebook + TikTok + YouTube, tudo vertical
 *  - Canal Espacial: 1 canal YouTube horizontal
 *  - Facebook independente: 1 página vertical, sem outras redes
 * Os nomes são marcadores: renomeie ou apague pela interface.
 */
import { PrismaClient, type SocialPlatform, type VideoFormat } from '@prisma/client';

const prisma = new PrismaClient();
const WS = 'ws_default';

async function main() {
  await prisma.workspace.upsert({ where: { id: WS }, update: {}, create: { id: WS, name: 'Meu workspace', wallet: { create: {} } } });

  const account = (platform: SocialPlatform, displayName: string) =>
    prisma.socialAccount.upsert({
      where: { workspaceId_platform_displayName: { workspaceId: WS, platform, displayName } },
      update: {},
      create: { workspaceId: WS, platform, displayName },
    });

  const group = async (name: string, defaultFormat: VideoFormat, accounts: Array<{ id: string }>) => {
    const g = await prisma.accountGroup.upsert({
      where: { workspaceId_name: { workspaceId: WS, name } },
      update: {},
      create: { workspaceId: WS, name, defaultFormat },
    });
    await prisma.groupMembership.createMany({ data: accounts.map((a) => ({ groupId: g.id, socialAccountId: a.id })), skipDuplicates: true });
  };

  const fb = await Promise.all([1, 2, 3].map((n) => account('FACEBOOK', `Luciano ZEEN — Facebook ${n}`)));
  const tt = await account('TIKTOK', 'Luciano ZEEN — TikTok');
  const yt = await account('YOUTUBE', 'Luciano ZEEN — YouTube');
  const espacial = await account('YOUTUBE', 'Canal Espacial — YouTube');
  const fbSolo = await account('FACEBOOK', 'Página Facebook independente');

  await prisma.client.upsert({ where: { workspaceId_name: { workspaceId: WS, name: 'Luciano ZEEN' } }, update: {}, create: { workspaceId: WS, name: 'Luciano ZEEN' } });

  await group('Luciano ZEEN', 'VERTICAL_9_16', [...fb, tt, yt]);
  await group('Canal Espacial', 'HORIZONTAL_16_9', [espacial]);
  await group('Facebook independente', 'VERTICAL_9_16', [fbSolo]);
  console.log('Seed de exemplo aplicado.');
}

main().finally(() => prisma.$disconnect());
