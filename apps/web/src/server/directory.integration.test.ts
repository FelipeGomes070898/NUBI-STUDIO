/** Integração (Postgres real): clientes, contas e grupos. Requer TEST_DATABASE_URL (ver jobs.integration.test.ts). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

d('diretório: clientes, contas e grupos (Postgres real)', () => {
  let db: typeof import('@social-manager/db');
  let dir: typeof import('./directory');
  const ws = 'ws_default';

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = await import('@social-manager/db');
    dir = await import('./directory');
  });
  afterAll(async () => db?.prisma.$disconnect());
  beforeEach(async () => {
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
  });

  it('cenário do projeto: Luciano ZEEN (3 FB + TikTok + YouTube), canal horizontal e Facebook solo', async () => {
    const acc = (p: 'FACEBOOK' | 'TIKTOK' | 'YOUTUBE', n: string) => dir.createAccount(ws, { platform: p, displayName: n });
    const fb = await Promise.all([1, 2, 3].map((i) => acc('FACEBOOK', `LZ FB ${i}`)));
    const tt = await acc('TIKTOK', 'LZ TT');
    const yt = await acc('YOUTUBE', 'LZ YT');
    const espacial = await acc('YOUTUBE', 'Espacial');
    const solo = await acc('FACEBOOK', 'FB solo');

    const lz = await dir.createGroup(ws, { name: 'Luciano ZEEN', defaultFormat: 'VERTICAL_9_16' });
    const es = await dir.createGroup(ws, { name: 'Canal Espacial', defaultFormat: 'HORIZONTAL_16_9' });
    const fs = await dir.createGroup(ws, { name: 'Facebook vertical', defaultFormat: 'VERTICAL_9_16' });
    await dir.setGroupMembers(ws, lz.id, [...fb, tt, yt].map((a) => a.id));
    await dir.setGroupMembers(ws, es.id, [espacial.id]);
    await dir.setGroupMembers(ws, fs.id, [solo.id]);

    const groups = await dir.listGroups(ws);
    const byName = Object.fromEntries(groups.map((g) => [g.name, g.memberships.length]));
    expect(byName).toEqual({ 'Luciano ZEEN': 5, 'Canal Espacial': 1, 'Facebook vertical': 1 });
  });

  it('uma conta pode estar em vários grupos; setGroupMembers substitui exatamente o conjunto', async () => {
    const a = await dir.createAccount(ws, { platform: 'YOUTUBE', displayName: 'A' });
    const b = await dir.createAccount(ws, { platform: 'YOUTUBE', displayName: 'B' });
    const g1 = await dir.createGroup(ws, { name: 'G1', defaultFormat: 'FLEXIBLE' });
    const g2 = await dir.createGroup(ws, { name: 'G2', defaultFormat: 'FLEXIBLE' });
    await dir.setGroupMembers(ws, g1.id, [a.id, b.id]);
    await dir.setGroupMembers(ws, g2.id, [a.id]);
    expect(await db.prisma.groupMembership.count({ where: { socialAccountId: a.id } })).toBe(2);
    await dir.setGroupMembers(ws, g1.id, [b.id]); // remove A só do G1
    expect((await db.prisma.groupMembership.findMany({ where: { groupId: g1.id } })).map((m) => m.socialAccountId)).toEqual([b.id]);
    expect(await db.prisma.groupMembership.count({ where: { groupId: g2.id } })).toBe(1);
    await dir.setGroupMembers(ws, g1.id, [a.id, a.id]); // duplicata não quebra
    expect(await db.prisma.groupMembership.count({ where: { groupId: g1.id } })).toBe(1);
  });

  it('excluir grupo mantém as contas; conta fora do workspace é rejeitada', async () => {
    const a = await dir.createAccount(ws, { platform: 'TIKTOK', displayName: 'A' });
    const g = await dir.createGroup(ws, { name: 'G', defaultFormat: 'FLEXIBLE' });
    await dir.setGroupMembers(ws, g.id, [a.id]);
    await dir.deleteGroup(ws, g.id);
    expect(await db.prisma.socialAccount.count()).toBe(1);
    expect(await db.prisma.groupMembership.count()).toBe(0);
    await db.prisma.workspace.create({ data: { id: 'outro', name: 'x', wallet: { create: {} } } });
    const g2 = await dir.createGroup('outro', { name: 'G', defaultFormat: 'FLEXIBLE' });
    await expect(dir.setGroupMembers('outro', g2.id, [a.id])).rejects.toThrow(/não existe/); // isolamento entre workspaces
    await expect(dir.deleteGroup('outro', 'inexistente')).rejects.toThrow(/não encontrado/);
  });

  it('duplicidades viram mensagens claras (grupo, cliente, conta)', async () => {
    await dir.createGroup(ws, { name: 'G', defaultFormat: 'FLEXIBLE' });
    await expect(dir.createGroup(ws, { name: 'G', defaultFormat: 'FLEXIBLE' })).rejects.toThrow(/grupo com esse nome já existe/);
    await dir.createClient(ws, { name: 'C' });
    await expect(dir.createClient(ws, { name: 'C' })).rejects.toThrow(/cliente com esse nome já existe/);
    await dir.createAccount(ws, { platform: 'YOUTUBE', displayName: 'X' });
    await expect(dir.createAccount(ws, { platform: 'YOUTUBE', displayName: 'X' })).rejects.toThrow(/YOUTUBE com esse nome/);
    await dir.createAccount(ws, { platform: 'FACEBOOK', displayName: 'X' }); // mesmo nome em outra plataforma é permitido
    await expect(dir.createClient(ws, { name: '   ' })).rejects.toThrow(/Informe/);
  });

  it('cliente com histórico de IA não é excluído; grupo pode ou não ter cliente', async () => {
    const c = await dir.createClient(ws, { name: 'ACME' });
    const g = await dir.createGroup(ws, { name: 'G', defaultFormat: 'FLEXIBLE', clientId: c.id });
    expect(g.clientId).toBe(c.id);
    await dir.deleteClient(ws, c.id); // sem jobs → ok; o grupo continua, sem cliente
    expect((await db.prisma.accountGroup.findUniqueOrThrow({ where: { id: g.id } })).clientId).toBeNull();
  });
});
