/** Publicação em múltiplas redes contra Postgres real, com publicadores simulados. Requer TEST_DATABASE_URL. */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PublishAccount, PublishAuth, PublishInput, Publisher } from './types';
import { PublishError } from './types';

const url = process.env.TEST_DATABASE_URL;
const d = url ? describe : describe.skip;
const HOUR = 3_600_000;

d('publicação (Postgres real)', () => {
  let db: typeof import('@social-manager/db');
  let svc: typeof import('./service');
  const ws = 'ws_default';

  let calls: Array<{ platform: string; account: string; input: PublishInput; token: string }>;
  let behavior: Record<string, (a: PublishAccount) => Promise<{ platformPostId: string; url?: string; note?: string }>>;
  const stub = (platform: 'YOUTUBE' | 'TIKTOK' | 'FACEBOOK' | 'INSTAGRAM', validate: (i: PublishInput) => string[] = () => []): Publisher => ({
    platform,
    validate,
    publish: async (acc, input, auth: PublishAuth) => {
      const token = await auth.getToken();
      calls.push({ platform, account: acc.displayName, input, token });
      await new Promise((r) => setTimeout(r, 15));
      return (behavior[acc.displayName] ?? (async () => ({ platformPostId: `id-${acc.displayName}`, url: `https://x/${acc.displayName}` })))(acc);
    },
  });
  const registry = () => ({
    YOUTUBE: stub('YOUTUBE', (i) => (i.title.trim() ? [] : ['YouTube: o título é obrigatório.'])),
    TIKTOK: stub('TIKTOK'),
    FACEBOOK: stub('FACEBOOK'),
    INSTAGRAM: stub('INSTAGRAM', (i) => (i.kind === 'STORY' && (i.media.durationSec ?? 0) > 60 ? ['Instagram: story em vídeo aceita até 60 segundos.'] : [])),
  });
  const auth = () => ({ getToken: async () => 'tok' });

  let accs: { yt: string; tt: string; fb: string; ig: string };
  let mediaId: string;
  const URLS = 'https://abc123.public.blob.vercel-storage.com/videos/v-xyz.mp4';

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
    db = await import('@social-manager/db');
    svc = await import('./service');
  });
  afterAll(async () => db?.prisma.$disconnect());
  beforeEach(async () => {
    calls = []; behavior = {};
    await db.prisma.$executeRawUnsafe(`TRUNCATE "Workspace" CASCADE`);
    await db.prisma.workspace.create({ data: { id: ws, name: 't', wallet: { create: {} } } });
    const mk = (platform: 'YOUTUBE' | 'TIKTOK' | 'FACEBOOK' | 'INSTAGRAM', displayName: string) =>
      db.prisma.socialAccount.create({ data: { workspaceId: ws, platform, displayName, platformAccountId: `p-${displayName}`, connectionStatus: 'CONNECTED', tokenCiphertext: 'x', scopes: ['video.publish'] } });
    accs = { yt: (await mk('YOUTUBE', 'YT')).id, tt: (await mk('TIKTOK', 'TT')).id, fb: (await mk('FACEBOOK', 'FB')).id, ig: (await mk('INSTAGRAM', 'IG')).id };
    mediaId = (await svc.registerMedia({ workspaceId: ws, url: URLS, name: 'v.mp4', sizeBytes: 5_000_000, mimeType: 'video/mp4', width: 1080, height: 1920, durationSec: 30 })).id;
  });

  const create = (o: Partial<Parameters<typeof svc.createPublication>[0]> = {}) =>
    svc.createPublication({ workspaceId: ws, mediaAssetId: mediaId, title: 'Título', body: 'Legenda', visibility: 'PUBLIC', groupIds: ['g1'], accountIds: [accs.yt, accs.tt, accs.fb], when: { mode: 'NOW' }, timezone: 'America/Sao_Paulo', ...o }, registry());
  const run = (o: Parameters<typeof svc.processDue>[0] = {}) => svc.processDue({ registry: registry(), auth, ...o });
  const targets = (publicationId: string) => db.prisma.publicationTarget.findMany({ where: { publicationId }, include: { account: true } });

  describe('mídia', () => {
    it('só aceita arquivo do nosso armazenamento, formato de vídeo e tamanho válido; calcula o formato', async () => {
      const m = await db.prisma.mediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
      expect(m).toMatchObject({ format: 'VERTICAL_9_16', url: URLS, width: 1080, height: 1920 });
      const base = { workspaceId: ws, name: 'x', sizeBytes: 1000, mimeType: 'video/mp4' };
      await expect(svc.registerMedia({ ...base, url: 'https://evil.com/v.mp4' })).rejects.toThrow(/enviado pelo próprio sistema/);
      await expect(svc.registerMedia({ ...base, url: 'http://abc.public.blob.vercel-storage.com/v.mp4' })).rejects.toThrow(/inválido/);
      await expect(svc.registerMedia({ ...base, url: 'https://abc.public.blob.vercel-storage.com.evil.com/v.mp4' })).rejects.toThrow(/próprio sistema/);
      await expect(svc.registerMedia({ ...base, url: URLS, mimeType: 'application/pdf' })).rejects.toThrow(/Formato/);
      await expect(svc.registerMedia({ ...base, url: URLS, sizeBytes: 99 * 1024 ** 3 })).rejects.toThrow(/limite/);
      expect(svc.formatFromSize(1920, 1080)).toBe('HORIZONTAL_16_9');
      expect(svc.formatFromSize(1000, 1000)).toBe('SQUARE_1_1');
      expect(svc.formatFromSize(null, null)).toBe('FLEXIBLE');
    });
  });

  describe('criar publicação', () => {
    it('cria uma publicação com um destino por conta, agendada para agora', async () => {
      const r = await create();
      expect(r.runNow).toBe(true);
      const p = await db.prisma.publication.findUniqueOrThrow({ where: { id: r.publicationId } });
      expect(p).toMatchObject({ status: 'SCHEDULED', title: 'Título', body: 'Legenda', visibility: 'PUBLIC', groupIds: ['g1'] });
      const t = await targets(r.publicationId);
      expect(t.map((x) => x.account.displayName).sort()).toEqual(['FB', 'TT', 'YT']);
      expect(t.every((x) => x.status === 'SCHEDULED' && x.scheduledAt)).toBe(true);
    });

    it('recusa contas inativas/desconectadas, sem vídeo, sem contas e regras da plataforma — tudo antes de gravar', async () => {
      await db.prisma.socialAccount.update({ where: { id: accs.tt }, data: { connectionStatus: 'PENDING_AUTH' } });
      await db.prisma.socialAccount.update({ where: { id: accs.fb }, data: { isActive: false } });
      const msg = await create().catch((x) => x.message);
      expect(msg).toMatch(/TT: não está conectada/);
      expect(msg).toMatch(/FB: conta inativa/);
      await expect(create({ accountIds: [] })).rejects.toThrow(/pelo menos uma conta/);
      await expect(create({ mediaAssetId: 'nao-existe', accountIds: [accs.yt] })).rejects.toThrow(/Envie o vídeo/);
      await expect(create({ accountIds: [accs.yt], title: '  ' })).rejects.toThrow(/título é obrigatório/);
      await expect(create({ accountIds: ['outra'] })).rejects.toThrow(/não existe mais/);
      expect(await db.prisma.publication.count()).toBe(0);
    });

    it('agendamento: precisa estar no futuro; guarda o horário em todos os destinos', async () => {
      const when = new Date(Date.now() + 3 * HOUR);
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(Date.now() - HOUR) } })).rejects.toThrow(/futuro/);
      const r = await create({ when: { mode: 'SCHEDULE', scheduledAt: when } });
      expect(r.runNow).toBe(false);
      expect((await targets(r.publicationId)).every((t) => t.scheduledAt!.getTime() === when.getTime())).toBe(true);
    });
  });

  describe('intervalo mínimo entre publicações da mesma conta', () => {
    const at = (h: number) => new Date(Date.now() + h * HOUR);

    it('bloqueia horário a menos de 60 min de outro, cita a conta e a hora; libera depois e em outra conta', async () => {
      await create({ when: { mode: 'SCHEDULE', scheduledAt: at(5) }, accountIds: [accs.yt] });
      const e = await create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(at(5).getTime() + 30 * 60_000) }, accountIds: [accs.yt, accs.tt] }).catch((x) => x);
      expect(e.message).toMatch(/YT \(YOUTUBE\) já tem publicação em \d{2}\/\d{2}\/\d{4}/);
      expect(e.message).not.toContain('TT (');
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(at(5).getTime() + 61 * 60_000) }, accountIds: [accs.yt] })).resolves.toBeTruthy();
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: at(5) }, accountIds: [accs.tt] })).resolves.toBeTruthy(); // outra conta no mesmo horário
    });

    it('"ignorar o intervalo" libera; cancelado e falho não bloqueiam; publicado recentemente bloqueia', async () => {
      const first = await create({ when: { mode: 'SCHEDULE', scheduledAt: at(6) }, accountIds: [accs.yt] });
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: at(6) }, accountIds: [accs.yt] })).rejects.toThrow(/intervalo mínimo/);
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: at(6) }, accountIds: [accs.yt], ignoreGap: true })).resolves.toBeTruthy();

      await db.prisma.publicationTarget.updateMany({ where: { publicationId: first.publicationId }, data: { status: 'CANCELLED' } });
      await db.prisma.publicationTarget.updateMany({ where: { NOT: { publicationId: first.publicationId } }, data: { status: 'FAILED' } });
      await expect(create({ when: { mode: 'SCHEDULE', scheduledAt: at(6) }, accountIds: [accs.yt] })).resolves.toBeTruthy();

      await create({ accountIds: [accs.tt] }); // "agora"
      await run();
      await expect(create({ accountIds: [accs.tt] })).rejects.toThrow(/TT \(TIKTOK\) já tem publicação/); // acabou de sair
    });

    it('duas criações simultâneas no mesmo horário: só uma passa (trava por workspace)', async () => {
      const when = at(8);
      const rs = await Promise.allSettled([1, 2, 3].map(() => create({ when: { mode: 'SCHEDULE', scheduledAt: when }, accountIds: [accs.yt] })));
      expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await db.prisma.publicationTarget.count({ where: { socialAccountId: accs.yt } })).toBe(1);
    });

    it('última postagem e último agendamento por conta', async () => {
      await create({ accountIds: [accs.yt] });
      await run();
      const sched = at(10);
      await create({ when: { mode: 'SCHEDULE', scheduledAt: sched }, accountIds: [accs.tt] });
      const act = await svc.getAccountActivity(ws);
      expect(act.get(accs.yt)!.POST.lastPublishedAt).toBeTruthy();
      expect(act.get(accs.yt)!.POST.lastScheduledAt).toBeNull();
      expect(act.get(accs.tt)!.POST.lastScheduledAt!.getTime()).toBe(sched.getTime());
      expect(act.get(accs.tt)!.POST.lastPublishedAt).toBeNull();
      expect(act.get(accs.tt)!.STORY.lastScheduledAt).toBeNull(); // story é um registro separado
    });
  });

  describe('executar', () => {
    it('publica nas três redes de uma vez com os dados certos e fecha a publicação', async () => {
      const r = await create();
      const stats = await run({ publicationId: r.publicationId });
      expect(stats).toMatchObject({ claimed: 3, published: 3, failed: 0 });
      expect(calls.map((c) => c.platform).sort()).toEqual(['FACEBOOK', 'TIKTOK', 'YOUTUBE']);
      expect(calls[0]!.input).toMatchObject({ title: 'Título', description: 'Legenda', visibility: 'PUBLIC', media: { url: URLS, sizeBytes: 5_000_000, mimeType: 'video/mp4' } });
      expect(calls.every((c) => c.token === 'tok')).toBe(true);
      const t = await targets(r.publicationId);
      expect(t.every((x) => x.status === 'PUBLISHED' && x.publishedAt && x.platformPostId && x.externalUrl && x.attempts === 1)).toBe(true);
      expect((await db.prisma.publication.findUniqueOrThrow({ where: { id: r.publicationId } })).status).toBe('PUBLISHED');
    });

    it('só processa o que já venceu: agendado para o futuro espera', async () => {
      const future = await create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(Date.now() + 5 * HOUR) }, accountIds: [accs.yt] });
      const now = await create({ accountIds: [accs.tt] });
      const stats = await run();
      expect(stats.claimed).toBe(1);
      expect((await targets(future.publicationId))[0]!.status).toBe('SCHEDULED');
      expect((await targets(now.publicationId))[0]!.status).toBe('PUBLISHED');
      // quando o horário chega, sai
      await db.prisma.publicationTarget.updateMany({ where: { publicationId: future.publicationId }, data: { scheduledAt: new Date(Date.now() - 1000) } });
      expect((await run()).published).toBe(1);
    });

    it('falha em uma rede não impede as outras; erro conhecido aparece, erro interno não vaza detalhes', async () => {
      behavior.TT = async () => { throw new PublishError('O TikTok limitou o número de posts deste perfil por hoje.'); };
      behavior.FB = async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:5432 senha=segredo'); };
      const r = await create();
      expect(await run({ publicationId: r.publicationId })).toMatchObject({ published: 1, failed: 2 });
      const t = Object.fromEntries((await targets(r.publicationId)).map((x) => [x.account.displayName, x]));
      expect(t.YT!.status).toBe('PUBLISHED');
      expect(t.TT).toMatchObject({ status: 'FAILED', lastError: 'O TikTok limitou o número de posts deste perfil por hoje.' });
      expect(t.FB!.status).toBe('FAILED');
      expect(t.FB!.lastError).toBe('Falha interna ao publicar. Veja os logs do servidor.');
      expect(t.FB!.lastError).not.toContain('segredo');
      expect((await db.prisma.publication.findUniqueOrThrow({ where: { id: r.publicationId } })).status).toBe('FAILED');
    });

    it('aviso da plataforma fica em "note", sem marcar erro', async () => {
      behavior.TT = async () => ({ platformPostId: 'p1', note: 'Só permitiu SELF_ONLY' });
      const r = await create({ accountIds: [accs.tt] });
      await run();
      expect((await targets(r.publicationId))[0]).toMatchObject({ status: 'PUBLISHED', note: 'Só permitiu SELF_ONLY', lastError: null });
    });

    it('DUAS execuções ao mesmo tempo nunca publicam o mesmo destino duas vezes', async () => {
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(Date.now() + (rs0++) * 2 * HOUR + 2 * HOUR) }, accountIds: [accs.yt, accs.tt, accs.fb], ignoreGap: true })));
      await db.prisma.publicationTarget.updateMany({ data: { scheduledAt: new Date(Date.now() - 1000) } });
      await Promise.all([run(), run(), run(), run()]);
      expect(calls).toHaveLength(15); // 5 publicações × 3 redes, cada uma exatamente uma vez
      expect(new Set(calls.map((c) => `${c.platform}`)).size).toBe(3);
      expect((await db.prisma.publicationTarget.findMany()).every((t) => t.status === 'PUBLISHED' && t.attempts === 1)).toBe(true);
      expect(rs).toHaveLength(5);
    });

    it('execução interrompida (processo caiu) vira falha, sem repetir sozinha', async () => {
      const r = await create({ accountIds: [accs.yt] });
      await db.prisma.publicationTarget.updateMany({ where: { publicationId: r.publicationId }, data: { status: 'PUBLISHING', claimedAt: new Date(Date.now() - 30 * 60_000) } });
      const stats = await run();
      expect(stats).toMatchObject({ reaped: 1, claimed: 0 });
      expect(calls).toHaveLength(0);
      expect((await targets(r.publicationId))[0]).toMatchObject({ status: 'FAILED' });
      expect((await targets(r.publicationId))[0]!.lastError).toMatch(/Confira na plataforma/);
    });
  });

  describe('tentar de novo e cancelar', () => {
    it('tentar de novo só vale para falhas e publica ao processar; cancelar só o que está agendado', async () => {
      behavior.YT = async () => { throw new PublishError('cota'); };
      const r = await create({ accountIds: [accs.yt] });
      await run();
      const tid = (await targets(r.publicationId))[0]!.id;
      behavior.YT = async () => ({ platformPostId: 'ok' });
      expect(await svc.retryTarget(ws, tid)).toBe(r.publicationId);
      expect((await run()).published).toBe(1);
      expect((await targets(r.publicationId))[0]).toMatchObject({ status: 'PUBLISHED', attempts: 2, lastError: null });
      await expect(svc.retryTarget(ws, tid)).rejects.toThrow(/falhou/);
      await expect(svc.cancelTarget(ws, tid)).rejects.toThrow(/ainda está agendado/);
      await expect(svc.retryTarget('outro', tid)).rejects.toThrow(/não encontrado/);

      const sch = await create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(Date.now() + 9 * HOUR) }, accountIds: [accs.tt] });
      await svc.cancelTarget(ws, (await targets(sch.publicationId))[0]!.id);
      expect((await db.prisma.publication.findUniqueOrThrow({ where: { id: sch.publicationId } })).status).toBe('CANCELLED');
      expect((await run()).claimed).toBe(0); // cancelado não sai
    });
  });

  describe('story e Instagram', () => {
    const at = (h: number) => new Date(Date.now() + h * HOUR);

    it('story só nas redes que têm story; as outras são recusadas com o motivo', async () => {
      const e = await create({ kind: 'STORY', accountIds: [accs.yt, accs.tt, accs.fb] }).catch((x) => x.message);
      expect(e).toMatch(/YT: YouTube: não tem story/);
      expect(e).toMatch(/TT: TikTok: não tem story/);
      expect(e).not.toMatch(/FB:/);
      expect(await db.prisma.publication.count()).toBe(0);
    });

    it('cria story no Facebook e no Instagram e o publicador recebe kind STORY', async () => {
      const r = await create({ kind: 'STORY', accountIds: [accs.fb, accs.ig] });
      expect((await db.prisma.publication.findUniqueOrThrow({ where: { id: r.publicationId } })).kind).toBe('STORY');
      expect((await targets(r.publicationId)).every((t) => t.kind === 'STORY')).toBe(true);
      await run({ publicationId: r.publicationId });
      expect(calls.map((c) => `${c.platform}:${c.input.kind}`).sort()).toEqual(['FACEBOOK:STORY', 'INSTAGRAM:STORY']);
    });

    it('regra das plataformas vale para story (Instagram: até 60s) e no Instagram não há publicação privada no stub', async () => {
      await db.prisma.mediaAsset.update({ where: { id: mediaId }, data: { durationSec: 90 } });
      await expect(create({ kind: 'STORY', accountIds: [accs.ig] })).rejects.toThrow(/até 60 segundos/);
      await expect(create({ kind: 'POST', accountIds: [accs.ig] })).resolves.toBeTruthy(); // como Reels, 90s é aceito
    });

    it('"postar também como story": 1 publicação de post para todas + 1 de story só para Facebook/Instagram', async () => {
      const r = await create({ alsoStory: true, accountIds: [accs.yt, accs.tt, accs.fb, accs.ig] });
      expect(r.publicationIds).toHaveLength(2);
      const pubs = await db.prisma.publication.findMany({ where: { id: { in: r.publicationIds } }, include: { targets: { include: { account: true } } } });
      const post = pubs.find((p) => p.kind === 'POST')!;
      const story = pubs.find((p) => p.kind === 'STORY')!;
      expect(post.targets).toHaveLength(4);
      expect(story.targets.map((t) => t.account.displayName).sort()).toEqual(['FB', 'IG']);
      expect(story.scheduledAt!.getTime()).toBe(post.scheduledAt!.getTime());
      await expect(create({ alsoStory: true, accountIds: [accs.yt, accs.tt] })).rejects.toThrow(/ao menos uma conta do Facebook ou do Instagram/);
      expect(await db.prisma.publication.count()).toBe(2); // a tentativa inválida não criou nada
    });

    it('o intervalo vale por conta E por tipo: story não bloqueia post, mas story não repete story', async () => {
      const when = at(5);
      await create({ kind: 'POST', when: { mode: 'SCHEDULE', scheduledAt: when }, accountIds: [accs.fb] });
      await expect(create({ kind: 'STORY', when: { mode: 'SCHEDULE', scheduledAt: when }, accountIds: [accs.fb] })).resolves.toBeTruthy(); // mesmo horário, tipo diferente
      const e = await create({ kind: 'STORY', when: { mode: 'SCHEDULE', scheduledAt: new Date(when.getTime() + 20 * 60_000) }, accountIds: [accs.fb] }).catch((x) => x.message);
      expect(e).toMatch(/FB \[story\] \(FACEBOOK\) já tem publicação/);
      await expect(create({ kind: 'POST', when: { mode: 'SCHEDULE', scheduledAt: new Date(when.getTime() + 20 * 60_000) }, accountIds: [accs.fb] })).rejects.toThrow(/intervalo mínimo/);
    });

    it('conflito no story bloqueia o conjunto inteiro (nada é criado pela metade)', async () => {
      const when = at(7);
      await create({ kind: 'STORY', when: { mode: 'SCHEDULE', scheduledAt: when }, accountIds: [accs.ig] });
      const before = await db.prisma.publication.count();
      await expect(create({ alsoStory: true, when: { mode: 'SCHEDULE', scheduledAt: when }, accountIds: [accs.tt, accs.ig] })).rejects.toThrow(/IG \[story\]/);
      expect(await db.prisma.publication.count()).toBe(before);
    });

    it('atividade por tipo: último story separado do último post', async () => {
      await create({ kind: 'STORY', accountIds: [accs.fb] });
      await run();
      const act = await svc.getAccountActivity(ws);
      expect(act.get(accs.fb)!.STORY.lastPublishedAt).toBeTruthy();
      expect(act.get(accs.fb)!.POST.lastPublishedAt).toBeNull();
    });

    it('token recusado no Instagram marca a conta como expirada', async () => {
      await svc.defaultAuth('INSTAGRAM', ws, accs.ig).onTokenRejected!();
      expect((await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: accs.ig } })).connectionStatus).toBe('EXPIRED');
    });
  });

  describe('metas semanais', () => {
    let goals: typeof import('./goals');
    beforeAll(async () => { goals = await import('./goals'); });
    const row = (rows: Awaited<ReturnType<typeof goals.getWeeklyProgress>>['rows'], name: string, kind: 'POST' | 'STORY') => rows.find((r) => r.accountName === name && r.kind === kind)!;

    it('padrão: 1 post e 1 story no Facebook/Instagram, 1 post no YouTube/TikTok; sem story onde não existe', async () => {
      const { rows, summary } = await goals.getWeeklyProgress(ws);
      expect(rows.map((r) => `${r.accountName}:${r.kind}:${r.target}`).sort()).toEqual(['FB:POST:1', 'FB:STORY:1', 'IG:POST:1', 'IG:STORY:1', 'TT:POST:1', 'YT:POST:1']);
      expect(rows.every((r) => r.status === 'PENDING' && r.isDefault)).toBe(true);
      expect(summary).toMatchObject({ total: 6, done: 0, pending: 6 });
    });

    it('conta só o que foi PUBLICADO nesta semana, separa agendado e ignora a semana passada e falhas', async () => {
      await create({ accountIds: [accs.yt] }); await run();                                     // YT post publicado agora
      await create({ kind: 'STORY', accountIds: [accs.fb] }); await run();                     // FB story publicado agora
      const old = await create({ accountIds: [accs.tt], ignoreGap: true }); await run();         // TT publicado... e depois "envelhece"
      await db.prisma.publicationTarget.updateMany({ where: { publicationId: old.publicationId }, data: { publishedAt: new Date(Date.now() - 10 * 24 * HOUR) } });
      behavior.IG = async () => { throw new PublishError('falha'); };
      await create({ kind: 'STORY', accountIds: [accs.ig] }); await run();                      // falhou: não conta
      const { rows, summary } = await goals.getWeeklyProgress(ws);
      expect(row(rows, 'YT', 'POST')).toMatchObject({ done: 1, status: 'DONE' });
      expect(row(rows, 'FB', 'STORY')).toMatchObject({ done: 1, status: 'DONE' });
      expect(row(rows, 'FB', 'POST').status).toBe('PENDING');
      expect(row(rows, 'TT', 'POST')).toMatchObject({ done: 0, status: 'PENDING' });
      expect(row(rows, 'IG', 'STORY')).toMatchObject({ done: 0, status: 'PENDING' });
      expect(summary.done).toBe(2);
    });

    it('agendado dentro da semana cobre a meta ("agendada"); fora da semana não cobre', async () => {
      const { end } = goals.weekRange(new Date());
      await create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(Date.now() + 2 * HOUR < end.getTime() ? Date.now() + 2 * HOUR : end.getTime() - HOUR) }, accountIds: [accs.tt] });
      await create({ when: { mode: 'SCHEDULE', scheduledAt: new Date(end.getTime() + 2 * HOUR) }, accountIds: [accs.fb] });
      const { rows } = await goals.getWeeklyProgress(ws);
      expect(row(rows, 'TT', 'POST')).toMatchObject({ scheduled: 1, status: 'SCHEDULED' });
      expect(row(rows, 'FB', 'POST')).toMatchObject({ scheduled: 0, status: 'PENDING' });
    });

    it('meta editável (0 desliga), validada, e story não existe em YouTube/TikTok', async () => {
      await goals.setWeeklyGoal(ws, accs.fb, 'STORY', 3);
      await goals.setWeeklyGoal(ws, accs.yt, 'POST', 0);
      const { rows, summary } = await goals.getWeeklyProgress(ws);
      expect(row(rows, 'FB', 'STORY')).toMatchObject({ target: 3, isDefault: false });
      expect(row(rows, 'YT', 'POST').status).toBe('OFF');
      expect(summary.total).toBe(5); // a desligada não conta
      await expect(goals.setWeeklyGoal(ws, accs.yt, 'STORY', 1)).rejects.toThrow(/Story só existe/);
      await expect(goals.setWeeklyGoal(ws, accs.fb, 'POST', 51)).rejects.toThrow(/entre 0 e 50/);
      await expect(goals.setWeeklyGoal(ws, accs.fb, 'POST', 1.5)).rejects.toThrow(/inteiro/);
      await expect(goals.setWeeklyGoal('outro', accs.fb, 'POST', 1)).rejects.toThrow(/não encontrada/);
    });
  });

  it('quando a rede recusa o token, a conta passa a "token expirado"', async () => {
    const a = svc.defaultAuth('TIKTOK', ws, accs.tt);
    await a.onTokenRejected!();
    expect((await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: accs.tt } })).connectionStatus).toBe('EXPIRED');
    await svc.defaultAuth('FACEBOOK', ws, accs.fb).onTokenRejected!();
    expect((await db.prisma.socialAccount.findUniqueOrThrow({ where: { id: accs.fb } })).connectionStatus).toBe('EXPIRED');
  });
});

let rs0 = 0;
