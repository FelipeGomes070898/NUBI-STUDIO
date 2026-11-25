import { prisma, Prisma } from '@social-manager/db';
import { decryptSecret, encryptSecret } from '../crypto';
import { ProviderError } from '../ai/types';
import { UserError } from '../errors';
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
  return { revoked };
}
