import { prisma, Prisma } from '@social-manager/db';
import { decryptSecret, encryptSecret } from '../crypto';
import { ProviderError } from '../ai/types';
import { UserError } from '../errors';
import {
  exchangeFacebookCode, exchangeLongLived, fetchGrantedScopes, fetchPages, REQUIRED_FACEBOOK_SCOPE, type FacebookPage, type MetaClient,
} from './facebook';
import {
  exchangeCode, fetchMyChannel, refreshAccessToken, revokeToken, YOUTUBE_SCOPES, type GoogleClient,
} from './youtube';

export function googleClientFromEnv(): GoogleClient {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new UserError('Conexão com YouTube não configurada: defina GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET na Vercel e faça um novo deploy.');
  }
  return { clientId, clientSecret };
}

export const youtubeConfigured = () => !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

/** URL pública do app. APP_URL manda; na Vercel cai no domínio de produção; senão, a origem da requisição. */
export function appOrigin(requestUrl: string): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return new URL(requestUrl).origin;
}

export const youtubeRedirectUri = (requestUrl: string) => `${appOrigin(requestUrl)}/api/oauth/youtube/callback`;
export const facebookRedirectUri = (requestUrl: string) => `${appOrigin(requestUrl)}/api/oauth/facebook/callback`;

export function metaClientFromEnv(): MetaClient {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) {
    throw new UserError('Conexão com Facebook não configurada: defina META_APP_ID e META_APP_SECRET na Vercel e faça um novo deploy.');
  }
  return { appId, appSecret };
}

export const facebookConfigured = () => !!process.env.META_APP_ID && !!process.env.META_APP_SECRET;

/**
 * Conclui a conexão: troca o código, lê o canal e guarda os tokens CRIPTOGRAFADOS.
 *  - com accountId: conecta o canal a essa conta cadastrada;
 *  - sem accountId: reconecta a conta que já tem esse canal ou cria uma nova com o nome do canal.
 */
export async function connectYoutubeAccount(
  input: { workspaceId: string; code: string; verifier: string; redirectUri: string; accountId?: string },
  client: GoogleClient = googleClientFromEnv(),
) {
  const tokens = await exchangeCode(client, { code: input.code, verifier: input.verifier, redirectUri: input.redirectUri });

  const missing = YOUTUBE_SCOPES.filter((s) => !tokens.scopes.includes(s));
  if (missing.length) {
    throw new UserError('Autorização incompleta: o Google não liberou todas as permissões pedidas. Conecte de novo e deixe todas as caixas marcadas.');
  }
  if (!tokens.refreshToken) {
    throw new UserError('O Google não devolveu o acesso permanente. Remova o app em myaccount.google.com/permissions e conecte de novo.');
  }

  const channel = await fetchMyChannel(client, tokens.accessToken);
  const data = {
    platformAccountId: channel.id,
    handle: channel.customUrl ?? null,
    tokenCiphertext: encryptSecret(tokens.accessToken),
    refreshTokenCiphertext: encryptSecret(tokens.refreshToken),
    tokenExpiresAt: tokens.expiresAt,
    scopes: tokens.scopes,
    connectionStatus: 'CONNECTED' as const,
    isActive: true,
  };

  try {
    return await prisma.$transaction(async (tx) => {
      const same = await tx.socialAccount.findFirst({
        where: { workspaceId: input.workspaceId, platform: 'YOUTUBE', platformAccountId: channel.id },
      });

      if (input.accountId) {
        const target = await tx.socialAccount.findFirst({ where: { id: input.accountId, workspaceId: input.workspaceId, platform: 'YOUTUBE' } });
        if (!target) throw new UserError('A conta escolhida não existe ou não é do YouTube.');
        if (same && same.id !== target.id) {
          throw new UserError(`Este canal (${channel.title}) já está conectado à conta "${same.displayName}". Use aquela conta ou desconecte-a antes.`);
        }
        const acc = await tx.socialAccount.update({ where: { id: target.id }, data });
        return { account: acc, channel, created: false };
      }

      if (same) return { account: await tx.socialAccount.update({ where: { id: same.id }, data }), channel, created: false };

      const taken = await tx.socialAccount.findFirst({ where: { workspaceId: input.workspaceId, platform: 'YOUTUBE', displayName: channel.title } });
      const displayName = taken ? `${channel.title} (${channel.id.slice(-6)})` : channel.title;
      const acc = await tx.socialAccount.create({ data: { ...data, workspaceId: input.workspaceId, platform: 'YOUTUBE', displayName } });
      return { account: acc, channel, created: true };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new UserError('Já existe uma conta com esse nome ou canal. Renomeie a existente e tente de novo.');
    }
    throw e;
  }
}

export interface FacebookConnectResult {
  connected: Array<{ accountId: string; page: string; created: boolean }>;
  /** Mensagem extra quando a conta escolhida não pôde ser associada a uma página específica. */
  note?: string;
}

/**
 * Conclui a conexão do Facebook: troca o código, pega o token longo e grava UMA conta por Página liberada
 * (o token guardado é o da Página, criptografado). Reconectar atualiza a conta existente pelo id da Página.
 *  - com accountId: se voltar uma única Página, ela é ligada a essa conta; se voltarem várias, só se o
 *    nome da Página for igual ao nome da conta (senão a conta escolhida fica como está e dizemos isso).
 */
export async function connectFacebookPages(
  input: { workspaceId: string; code: string; redirectUri: string; accountId?: string },
  client: MetaClient = metaClientFromEnv(),
): Promise<FacebookConnectResult> {
  const short = await exchangeFacebookCode(client, { code: input.code, redirectUri: input.redirectUri });
  const long = await exchangeLongLived(client, short.accessToken);

  const granted = await fetchGrantedScopes(client, long.accessToken);
  if (!granted.includes(REQUIRED_FACEBOOK_SCOPE)) {
    throw new UserError('Autorização incompleta: falta a permissão de publicar em Páginas. Conecte de novo e deixe todas as caixas marcadas.');
  }

  const pages = await fetchPages(client, long.accessToken);
  if (pages.length === 0) {
    throw new UserError('Nenhuma Página foi liberada. Conecte de novo, escolha as Páginas na tela da Meta e confirme que você é administrador delas.');
  }

  const dataFor = (p: FacebookPage) => ({
    platformAccountId: p.id,
    handle: p.username ? `@${p.username}` : null,
    tokenCiphertext: encryptSecret(p.accessToken),
    refreshTokenCiphertext: null, // o Facebook não tem refresh token: o token da Página vem do token longo
    tokenExpiresAt: null, // token de Página derivado de token longo não expira; revogação é detectada ao publicar
    scopes: granted,
    connectionStatus: 'CONNECTED' as const,
    isActive: true,
  });

  try {
    return await prisma.$transaction(async (tx) => {
      const connected: FacebookConnectResult['connected'] = [];
      let note: string | undefined;

      let bindTo: { id: string; displayName: string } | null = null;
      if (input.accountId) {
        const target = await tx.socialAccount.findFirst({ where: { id: input.accountId, workspaceId: input.workspaceId, platform: 'FACEBOOK' } });
        if (!target) throw new UserError('A conta escolhida não existe ou não é do Facebook.');
        bindTo = target;
      }
      const bindPage = bindTo
        ? pages.length === 1
          ? pages[0]!
          : pages.find((p) => p.name.toLowerCase() === bindTo!.displayName.toLowerCase())
        : undefined;
      if (bindTo && !bindPage) {
        note = `Voltaram ${pages.length} Páginas e nenhuma tem o nome "${bindTo.displayName}"; elas foram cadastradas pelo nome da Página e a conta "${bindTo.displayName}" ficou como estava.`;
      }

      for (const page of pages) {
        const same = await tx.socialAccount.findFirst({ where: { workspaceId: input.workspaceId, platform: 'FACEBOOK', platformAccountId: page.id } });
        if (bindTo && bindPage?.id === page.id) {
          if (same && same.id !== bindTo.id) {
            throw new UserError(`A Página "${page.name}" já está conectada à conta "${same.displayName}". Use aquela conta ou desconecte-a antes.`);
          }
          await tx.socialAccount.update({ where: { id: bindTo.id }, data: dataFor(page) });
          connected.push({ accountId: bindTo.id, page: page.name, created: false });
        } else if (same) {
          await tx.socialAccount.update({ where: { id: same.id }, data: dataFor(page) });
          connected.push({ accountId: same.id, page: page.name, created: false });
        } else {
          const taken = await tx.socialAccount.findFirst({ where: { workspaceId: input.workspaceId, platform: 'FACEBOOK', displayName: page.name } });
          const displayName = taken ? `${page.name} (${page.id.slice(-6)})` : page.name;
          const acc = await tx.socialAccount.create({ data: { ...dataFor(page), workspaceId: input.workspaceId, platform: 'FACEBOOK', displayName } });
          connected.push({ accountId: acc.id, page: page.name, created: true });
        }
      }
      return { connected, note };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      throw new UserError('Já existe uma conta com esse nome ou Página. Renomeie a existente e tente de novo.');
    }
    throw e;
  }
}

/** Token da Página para publicar. Sem refresh: se a Meta recusar (código 190) o publicador chama markFacebookExpired. */
export async function getFacebookPageToken(workspaceId: string, accountId: string): Promise<string> {
  const acc = await prisma.socialAccount.findFirst({ where: { id: accountId, workspaceId, platform: 'FACEBOOK' } });
  if (!acc) throw new UserError('Conta não encontrada.');
  if (acc.connectionStatus !== 'CONNECTED' || !acc.tokenCiphertext) {
    throw new UserError(`A página "${acc.displayName}" não está conectada ao Facebook. Conecte-a em Contas sociais.`);
  }
  return decryptSecret(acc.tokenCiphertext);
}

export async function markFacebookExpired(workspaceId: string, accountId: string) {
  await prisma.socialAccount.updateMany({ where: { id: accountId, workspaceId, platform: 'FACEBOOK' }, data: { connectionStatus: 'EXPIRED' } });
}

/**
 * Access token válido para publicar. Renova sozinho (e persiste) quando perto de expirar.
 * Se o Google disser que o acesso foi revogado/expirou, a conta vira EXPIRED e pede reconexão.
 */
export async function getYoutubeAccessToken(workspaceId: string, accountId: string, client: GoogleClient = googleClientFromEnv()): Promise<string> {
  const acc = await prisma.socialAccount.findFirst({ where: { id: accountId, workspaceId, platform: 'YOUTUBE' } });
  if (!acc) throw new UserError('Conta não encontrada.');
  if (acc.connectionStatus !== 'CONNECTED' || !acc.tokenCiphertext || !acc.refreshTokenCiphertext) {
    throw new UserError(`A conta "${acc.displayName}" não está conectada ao YouTube. Conecte-a em Contas sociais.`);
  }
  if (acc.tokenExpiresAt && acc.tokenExpiresAt.getTime() - Date.now() > 60_000) return decryptSecret(acc.tokenCiphertext);

  try {
    const t = await refreshAccessToken(client, decryptSecret(acc.refreshTokenCiphertext));
    await prisma.socialAccount.update({
      where: { id: acc.id },
      data: {
        tokenCiphertext: encryptSecret(t.accessToken),
        tokenExpiresAt: t.expiresAt,
        ...(t.refreshToken ? { refreshTokenCiphertext: encryptSecret(t.refreshToken) } : {}),
      },
    });
    return t.accessToken;
  } catch (e) {
    if (e instanceof ProviderError && e.message.includes('invalid_grant')) {
      await prisma.socialAccount.update({ where: { id: acc.id }, data: { connectionStatus: 'EXPIRED' } });
      throw new UserError(`O acesso da conta "${acc.displayName}" expirou ou foi revogado. Reconecte em Contas sociais.`);
    }
    throw e;
  }
}

/** Revoga no Google (melhor esforço) e apaga os tokens locais. A conta continua cadastrada. */
export async function disconnectAccount(workspaceId: string, accountId: string, client?: GoogleClient) {
  const acc = await prisma.socialAccount.findFirst({ where: { id: accountId, workspaceId } });
  if (!acc) throw new UserError('Conta não encontrada.');
  let revoked = false;
  if (acc.platform === 'YOUTUBE' && acc.refreshTokenCiphertext) {
    try {
      revoked = await revokeToken(client ?? googleClientFromEnv(), decryptSecret(acc.refreshTokenCiphertext));
    } catch {
      revoked = false; // sem credenciais/chave de criptografia: segue com a limpeza local
    }
  }
  await prisma.socialAccount.update({
    where: { id: acc.id },
    data: { tokenCiphertext: null, refreshTokenCiphertext: null, tokenExpiresAt: null, scopes: [], connectionStatus: 'PENDING_AUTH' },
  });
  return { revoked, platform: acc.platform };
}
