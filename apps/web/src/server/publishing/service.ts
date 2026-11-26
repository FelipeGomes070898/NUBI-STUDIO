import { prisma, Prisma, type PostStatus, type SocialPlatform, type VideoFormat } from '@social-manager/db';
import { UserError } from '../errors';
import { getFacebookPageToken, getTiktokAccessToken, getYoutubeAccessToken, markFacebookExpired } from '../oauth/connect';
import { defaultPublishers, publisherFor, type PublisherRegistry } from './publishers';
import { assertSchedulable, describeConflicts, minGapMinutes } from './schedule';
import { DEFAULT_TIMEZONE, isValidTimeZone } from './time';
import { PublishError, VIDEO_MIME_TYPES, type PublishAuth, type PublishInput } from './types';

const BLOCKING: PostStatus[] = ['SCHEDULED', 'QUEUED', 'PUBLISHING', 'PUBLISHED'];
const PENDING: PostStatus[] = ['SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRY_SCHEDULED'];
const STUCK_AFTER_MS = 20 * 60 * 1000;

export const maxVideoBytes = () => (Number(process.env.MAX_VIDEO_MB) > 0 ? Number(process.env.MAX_VIDEO_MB) : 512) * 1024 * 1024;

// ── Mídia ─────────────────────────────────────────────────

/** O arquivo só pode estar no nosso armazenamento (Vercel Blob): o servidor vai baixá-lo e a Meta vai buscá-lo. */
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/;

export function formatFromSize(w?: number | null, h?: number | null): VideoFormat {
  if (!w || !h) return 'FLEXIBLE';
  if (w === h) return 'SQUARE_1_1';
  return h > w ? 'VERTICAL_9_16' : 'HORIZONTAL_16_9';
}

export async function registerMedia(input: {
  workspaceId: string; url: string; name: string; sizeBytes: number; mimeType: string;
  width?: number | null; height?: number | null; durationSec?: number | null; clientId?: string | null;
}) {
  let host: string;
  try {
    const u = new URL(input.url);
    if (u.protocol !== 'https:') throw new Error();
    host = u.hostname;
  } catch {
    throw new UserError('Endereço do vídeo inválido.');
  }
  if (!BLOB_HOST.test(host)) throw new UserError('O vídeo precisa ter sido enviado pelo próprio sistema.');
  if (!VIDEO_MIME_TYPES.includes(input.mimeType)) throw new UserError('Formato não aceito. Use MP4, MOV ou WebM.');
  if (!Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) throw new UserError('Tamanho do vídeo inválido.');
  if (input.sizeBytes > maxVideoBytes()) throw new UserError(`O vídeo passa do limite de ${Math.round(maxVideoBytes() / 1024 / 1024)} MB.`);
  const dim = (n?: number | null) => (n && Number.isFinite(n) && n > 0 ? Math.round(n) : null);
  return prisma.mediaAsset.create({
    data: {
      workspaceId: input.workspaceId,
      clientId: input.clientId || null,
      name: input.name.replace(/[\u0000-\u001f]/g, '').slice(0, 200) || 'video',
      storageKey: new URL(input.url).pathname.replace(/^\//, ''),
      url: input.url,
      mimeType: input.mimeType,
      sizeBytes: BigInt(Math.round(input.sizeBytes)),
      width: dim(input.width),
      height: dim(input.height),
      durationSec: input.durationSec && input.durationSec > 0 ? input.durationSec : null,
      format: formatFromSize(input.width, input.height),
    },
  });
}

// ── Criar publicação ──────────────────────────────────────

export interface CreatePublicationInput {
  workspaceId: string;
  clientId?: string | null;
  mediaAssetId: string;
  title: string;
  body: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  groupIds: string[];
  accountIds: string[];
  when: { mode: 'NOW' } | { mode: 'SCHEDULE'; scheduledAt: Date };
  /** Fuso do usuário (só para escrever os horários nas mensagens). */
  timezone?: string;
  /** Ignora o intervalo mínimo entre publicações da mesma conta. */
  ignoreGap?: boolean;
  now?: Date;
}

function toPublishInput(p: { title: string | null; body: string | null; visibility: string }, m: { url: string | null; sizeBytes: bigint; mimeType: string; width: number | null; height: number | null; durationSec: number | null }): PublishInput {
  return {
    title: p.title ?? '',
    description: p.body ?? '',
    visibility: p.visibility === 'PRIVATE' ? 'PRIVATE' : 'PUBLIC',
    media: { url: m.url!, sizeBytes: Number(m.sizeBytes), mimeType: m.mimeType, width: m.width, height: m.height, durationSec: m.durationSec },
  };
}

export async function createPublication(input: CreatePublicationInput, registry: PublisherRegistry = defaultPublishers()) {
  const now = input.now ?? new Date();
  const tz = isValidTimeZone(input.timezone) ? input.timezone : DEFAULT_TIMEZONE;
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length === 0) throw new UserError('Escolha pelo menos uma conta para publicar.');
  const title = input.title.trim();
  const body = input.body.trim();

  const media = await prisma.mediaAsset.findFirst({ where: { id: input.mediaAssetId, workspaceId: input.workspaceId } });
  if (!media?.url) throw new UserError('Envie o vídeo antes de publicar.');

  const accounts = await prisma.socialAccount.findMany({ where: { id: { in: accountIds }, workspaceId: input.workspaceId } });
  if (accounts.length !== accountIds.length) throw new UserError('Alguma conta escolhida não existe mais.');

  // 1) contas aptas
  const problems: string[] = [];
  for (const a of accounts) {
    if (!a.isActive) problems.push(`${a.displayName}: conta inativa.`);
    else if (a.connectionStatus !== 'CONNECTED') problems.push(`${a.displayName}: não está conectada (${a.platform}). Conecte em Contas sociais.`);
    else if (!registry[a.platform]) problems.push(`${a.displayName}: ainda não há publicação para ${a.platform}.`);
  }
  if (problems.length) throw new UserError(problems.join(' '));

  // 2) regras de cada plataforma (título, tamanhos, formato)
  const publishInput = toPublishInput({ title, body, visibility: input.visibility }, media);
  const platforms = [...new Set(accounts.map((a) => a.platform))];
  const errs = platforms.flatMap((p) => publisherFor(registry, p).validate(publishInput));
  if (errs.length) throw new UserError(errs.join(' '));

  // 3) horário
  const wanted = input.when.mode === 'NOW' ? now : input.when.scheduledAt;
  if (input.when.mode === 'SCHEDULE') assertSchedulable(wanted, now);

  // 4) intervalo mínimo por conta + criação, sob trava (duas criações ao mesmo tempo não furam a regra)
  const gap = minGapMinutes();
  const id = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.workspaceId}))`;

    if (!input.ignoreGap) {
      const from = new Date(wanted.getTime() - gap * 60_000);
      const to = new Date(wanted.getTime() + gap * 60_000);
      const near = await tx.publicationTarget.findMany({
        where: {
          socialAccountId: { in: accountIds },
          status: { in: BLOCKING },
          OR: [{ scheduledAt: { gte: from, lte: to } }, { publishedAt: { gte: from, lte: to } }],
        },
        select: { socialAccountId: true, scheduledAt: true, publishedAt: true },
      });
      const msg = describeConflicts(
        accounts.map((a) => ({
          accountName: a.displayName,
          platform: a.platform,
          taken: near.filter((n) => n.socialAccountId === a.id).map((n) => (n.publishedAt ?? n.scheduledAt)!),
        })),
        wanted, gap, tz,
      );
      if (msg) throw new UserError(msg);
    }

    const pub = await tx.publication.create({
      data: {
        workspaceId: input.workspaceId,
        clientId: input.clientId || null,
        mediaAssetId: media.id,
        title: title || null,
        body: body || null,
        groupIds: input.groupIds,
        visibility: input.visibility,
        scheduledAt: wanted,
        status: 'SCHEDULED',
        targets: { create: accounts.map((a) => ({ socialAccountId: a.id, status: 'SCHEDULED' as const, scheduledAt: wanted })) },
      },
      select: { id: true },
    });
    return pub.id;
  });

  return { publicationId: id, runNow: input.when.mode === 'NOW' };
}

// ── Execução ──────────────────────────────────────────────

/** Como obter o token de cada rede e o que fazer quando a rede o recusa. Injetável nos testes. */
export type AuthFactory = (platform: SocialPlatform, workspaceId: string, accountId: string) => PublishAuth;

export const defaultAuth: AuthFactory = (platform, workspaceId, accountId) => ({
  getToken: () =>
    platform === 'YOUTUBE' ? getYoutubeAccessToken(workspaceId, accountId)
    : platform === 'TIKTOK' ? getTiktokAccessToken(workspaceId, accountId)
    : getFacebookPageToken(workspaceId, accountId),
  onTokenRejected: async () => {
    if (platform === 'FACEBOOK') await markFacebookExpired(workspaceId, accountId);
    else await prisma.socialAccount.updateMany({ where: { id: accountId, workspaceId }, data: { connectionStatus: 'EXPIRED' } });
  },
});

export interface ProcessOptions {
  /** Só os destinos desta publicação (usado logo após "Publicar agora"). */
  publicationId?: string;
  /** Quantos destinos rodam em paralelo. */
  concurrency?: number;
  /** Para de PEGAR destinos novos depois deste tempo (a função tem limite de duração). */
  deadlineMs?: number;
  registry?: PublisherRegistry;
  auth?: AuthFactory;
}

/** Destinos que ficaram "publicando" sem terminar (processo caiu): vira falha — NÃO repete sozinho, para não duplicar post. */
export async function reapStuck(): Promise<number> {
  const r = await prisma.publicationTarget.updateMany({
    where: { status: 'PUBLISHING', claimedAt: { lt: new Date(Date.now() - STUCK_AFTER_MS) } },
    data: {
      status: 'FAILED',
      lastError: 'Interrompido: sem resposta por mais de 20 minutos. Confira na plataforma se o vídeo já saiu antes de tentar de novo.',
    },
  });
  return r.count;
}

/** Pega (de forma atômica, sem dois workers no mesmo destino) até `limit` destinos vencidos. */
async function claimDue(limit: number, publicationId?: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "PublicationTarget"
    SET status = 'PUBLISHING'::"PostStatus", "claimedAt" = (NOW() AT TIME ZONE 'UTC'), attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM "PublicationTarget"
      WHERE status = 'SCHEDULED'::"PostStatus"
        AND "scheduledAt" <= (NOW() AT TIME ZONE 'UTC')
        ${publicationId ? Prisma.sql`AND "publicationId" = ${publicationId}` : Prisma.empty}
      ORDER BY "scheduledAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id`;
  return rows.map((r) => r.id);
}

export async function processDue(opts: ProcessOptions = {}) {
  const registry = opts.registry ?? defaultPublishers();
  const authFor = opts.auth ?? defaultAuth;
  const concurrency = opts.concurrency ?? 3;
  const deadline = Date.now() + (opts.deadlineMs ?? 240_000);
  const stats = { claimed: 0, published: 0, failed: 0, reaped: await reapStuck() };

  while (Date.now() < deadline) {
    const ids = await claimDue(concurrency, opts.publicationId);
    if (ids.length === 0) break;
    stats.claimed += ids.length;
    const results = await Promise.all(ids.map((id) => runTarget(id, registry, authFor)));
    for (const ok of results) ok ? stats.published++ : stats.failed++;
  }
  return stats;
}

async function runTarget(targetId: string, registry: PublisherRegistry, authFor: AuthFactory): Promise<boolean> {
  const t = await prisma.publicationTarget.findUniqueOrThrow({
    where: { id: targetId },
    include: { account: true, publication: { include: { media: true } } },
  });
  const pub = t.publication;
  let ok = false;
  try {
    if (!pub.media?.url) throw new PublishError('O vídeo desta publicação não está mais disponível.');
    const publisher = publisherFor(registry, t.account.platform);
    const result = await publisher.publish(
      { id: t.account.id, displayName: t.account.displayName, platformAccountId: t.account.platformAccountId, scopes: t.account.scopes },
      toPublishInput(pub, pub.media),
      authFor(t.account.platform, pub.workspaceId, t.account.id),
    );
    await prisma.publicationTarget.update({
      where: { id: targetId },
      data: { status: 'PUBLISHED', platformPostId: result.platformPostId, externalUrl: result.url ?? null, publishedAt: new Date(), lastError: null, note: result.note ?? null },
    });
    ok = true;
  } catch (e) {
    const known = e instanceof PublishError || e instanceof UserError;
    if (!known) console.error('[publish]', targetId, e);
    await prisma.publicationTarget.update({
      where: { id: targetId },
      data: { status: 'FAILED', lastError: (known ? (e as Error).message : 'Falha interna ao publicar. Veja os logs do servidor.').slice(0, 1000) },
    });
  }
  await refreshPublicationStatus(pub.id);
  return ok;
}

export async function refreshPublicationStatus(publicationId: string) {
  const targets = await prisma.publicationTarget.findMany({ where: { publicationId }, select: { status: true } });
  const has = (s: PostStatus) => targets.some((t) => t.status === s);
  let status: PostStatus;
  if (targets.some((t) => PENDING.includes(t.status))) status = has('PUBLISHING') ? 'PUBLISHING' : 'SCHEDULED';
  else if (targets.every((t) => t.status === 'CANCELLED')) status = 'CANCELLED';
  else if (has('FAILED')) status = 'FAILED';
  else status = 'PUBLISHED';
  await prisma.publication.update({ where: { id: publicationId }, data: { status } });
}

/** Põe um destino com falha na fila de novo. Se a plataforma tiver publicado de fato (timeout), pode duplicar: a UI avisa. */
export async function retryTarget(workspaceId: string, targetId: string): Promise<string> {
  const t = await prisma.publicationTarget.findFirst({ where: { id: targetId, publication: { workspaceId } } });
  if (!t) throw new UserError('Destino não encontrado.');
  if (t.status !== 'FAILED') throw new UserError('Só dá para tentar de novo um destino que falhou.');
  await prisma.publicationTarget.update({ where: { id: t.id }, data: { status: 'SCHEDULED', scheduledAt: new Date(), lastError: null, note: null } });
  await refreshPublicationStatus(t.publicationId);
  return t.publicationId;
}

export async function cancelTarget(workspaceId: string, targetId: string) {
  const t = await prisma.publicationTarget.findFirst({ where: { id: targetId, publication: { workspaceId } } });
  if (!t) throw new UserError('Destino não encontrado.');
  const r = await prisma.publicationTarget.updateMany({ where: { id: t.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  if (r.count === 0) throw new UserError('Só dá para cancelar o que ainda está agendado (não começou a publicar).');
  await refreshPublicationStatus(t.publicationId);
}

// ── Consultas ─────────────────────────────────────────────

/** Última postagem e último agendamento por conta (para evitar marcar de novo no mesmo horário). */
export async function getAccountActivity(workspaceId: string) {
  const [published, scheduled] = await Promise.all([
    prisma.publicationTarget.groupBy({ by: ['socialAccountId'], where: { status: 'PUBLISHED', account: { workspaceId } }, _max: { publishedAt: true } }),
    prisma.publicationTarget.groupBy({ by: ['socialAccountId'], where: { status: { in: ['SCHEDULED', 'QUEUED', 'PUBLISHING'] }, account: { workspaceId } }, _max: { scheduledAt: true } }),
  ]);
  const map = new Map<string, { lastPublishedAt: Date | null; lastScheduledAt: Date | null }>();
  for (const p of published) map.set(p.socialAccountId, { lastPublishedAt: p._max.publishedAt, lastScheduledAt: null });
  for (const s of scheduled) map.set(s.socialAccountId, { lastPublishedAt: map.get(s.socialAccountId)?.lastPublishedAt ?? null, lastScheduledAt: s._max.scheduledAt });
  return map;
}

export function listPublications(workspaceId: string, take = 30) {
  return prisma.publication.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    take,
    include: { media: { select: { name: true, format: true, durationSec: true } }, targets: { include: { account: { select: { displayName: true, platform: true } } }, orderBy: { id: 'asc' } } },
  });
}
