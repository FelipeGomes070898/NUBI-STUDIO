import { prisma, type PublicationKind, type SocialPlatform } from '@social-manager/db';
import { UserError } from '../errors';
import { STORY_PLATFORMS } from './service';
import { DEFAULT_TIMEZONE, zonedToUtc } from './time';

/** Padrão do sistema (espelha o Plano do Facebook): 1 post e 1 story por semana; YouTube e TikTok, 1 post. */
export const DEFAULT_WEEKLY_TARGETS: Record<SocialPlatform, Partial<Record<PublicationKind, number>>> = {
  FACEBOOK: { POST: 1, STORY: 1 },
  INSTAGRAM: { POST: 1, STORY: 1 },
  YOUTUBE: { POST: 1 },
  TIKTOK: { POST: 1 },
};

export const kindsFor = (platform: SocialPlatform): PublicationKind[] => (STORY_PLATFORMS.includes(platform) ? ['POST', 'STORY'] : ['POST']);

function localYmd(d: Date, tz: string): { y: number; m: number; day: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { y: Number(g('year')), m: Number(g('month')), day: Number(g('day')), weekday };
}

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Semana de domingo 00:00 até o domingo seguinte 00:00, no fuso `tz`, devolvida em instantes UTC. */
export function weekRange(now: Date, tz: string = DEFAULT_TIMEZONE): { start: Date; end: Date } {
  const { y, m, day, weekday } = localYmd(now, tz);
  const sunday = Date.UTC(y, m - 1, day) - weekday * 86_400_000;
  return { start: zonedToUtc(`${ymd(sunday)}T00:00`, tz), end: zonedToUtc(`${ymd(sunday + 7 * 86_400_000)}T00:00`, tz) };
}

export type GoalStatus = 'DONE' | 'SCHEDULED' | 'PENDING' | 'OFF';

/** DONE = já publicou a meta; SCHEDULED = ainda não, mas o agendado já cobre; PENDING = falta criar; OFF = meta 0. */
export function goalStatus(target: number, done: number, scheduled: number): GoalStatus {
  if (target <= 0) return 'OFF';
  if (done >= target) return 'DONE';
  return done + scheduled >= target ? 'SCHEDULED' : 'PENDING';
}

export interface GoalRow {
  accountId: string;
  accountName: string;
  platform: SocialPlatform;
  connected: boolean;
  kind: PublicationKind;
  target: number;
  isDefault: boolean;
  done: number;
  scheduled: number;
  status: GoalStatus;
}

export async function getWeeklyProgress(workspaceId: string, now = new Date(), tz: string = DEFAULT_TIMEZONE) {
  const { start, end } = weekRange(now, tz);
  const [accounts, goals, published, scheduled] = await Promise.all([
    prisma.socialAccount.findMany({ where: { workspaceId, isActive: true }, orderBy: [{ platform: 'asc' }, { displayName: 'asc' }] }),
    prisma.weeklyGoal.findMany({ where: { workspaceId } }),
    prisma.publicationTarget.groupBy({ by: ['socialAccountId', 'kind'], where: { status: 'PUBLISHED', publishedAt: { gte: start, lt: end }, account: { workspaceId } }, _count: { _all: true } }),
    prisma.publicationTarget.groupBy({ by: ['socialAccountId', 'kind'], where: { status: { in: ['SCHEDULED', 'QUEUED', 'PUBLISHING'] }, scheduledAt: { gte: start, lt: end }, account: { workspaceId } }, _count: { _all: true } }),
  ]);
  const key = (id: string, k: PublicationKind) => `${id}:${k}`;
  const goalBy = new Map(goals.map((g) => [key(g.socialAccountId, g.kind), g.target]));
  const doneBy = new Map(published.map((p) => [key(p.socialAccountId, p.kind), p._count._all]));
  const schedBy = new Map(scheduled.map((p) => [key(p.socialAccountId, p.kind), p._count._all]));

  const rows: GoalRow[] = [];
  for (const a of accounts) {
    for (const kind of kindsFor(a.platform)) {
      const custom = goalBy.get(key(a.id, kind));
      const target = custom ?? DEFAULT_WEEKLY_TARGETS[a.platform][kind] ?? 0;
      const done = doneBy.get(key(a.id, kind)) ?? 0;
      const sched = schedBy.get(key(a.id, kind)) ?? 0;
      rows.push({
        accountId: a.id, accountName: a.displayName, platform: a.platform, connected: a.connectionStatus === 'CONNECTED',
        kind, target, isDefault: custom === undefined, done, scheduled: sched, status: goalStatus(target, done, sched),
      });
    }
  }
  const counted = rows.filter((r) => r.status !== 'OFF');
  return {
    start, end, rows,
    summary: { total: counted.length, done: counted.filter((r) => r.status === 'DONE').length, scheduled: counted.filter((r) => r.status === 'SCHEDULED').length, pending: counted.filter((r) => r.status === 'PENDING').length },
  };
}

export async function setWeeklyGoal(workspaceId: string, accountId: string, kind: PublicationKind, target: number) {
  if (!Number.isInteger(target) || target < 0 || target > 50) throw new UserError('A meta semanal deve ser um número inteiro entre 0 e 50.');
  const acc = await prisma.socialAccount.findFirst({ where: { id: accountId, workspaceId } });
  if (!acc) throw new UserError('Conta não encontrada.');
  if (!kindsFor(acc.platform).includes(kind)) throw new UserError('Story só existe no Facebook e no Instagram.');
  await prisma.weeklyGoal.upsert({
    where: { socialAccountId_kind: { socialAccountId: accountId, kind } },
    create: { workspaceId, socialAccountId: accountId, kind, target },
    update: { target },
  });
}
