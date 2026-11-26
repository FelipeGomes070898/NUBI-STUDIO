import { randomBytes } from 'node:crypto';
import { ProviderError } from '../ai/types';

/**
 * user.info.basic = identificar a conta; video.upload = enviar como rascunho; video.publish = Direct Post.
 * Se o portal do TikTok recusar algum escopo ("invalid_scope") porque o produto ainda não foi liberado no app,
 * ajuste com TIKTOK_SCOPES (separados por vírgula).
 */
export const DEFAULT_TIKTOK_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
export const REQUIRED_TIKTOK_SCOPE = 'user.info.basic';
const PUBLISH_SCOPES = ['video.publish', 'video.upload'];

export function tiktokScopes(): string[] {
  const custom = process.env.TIKTOK_SCOPES?.split(',').map((s) => s.trim()).filter(Boolean);
  return custom?.length ? custom : DEFAULT_TIKTOK_SCOPES;
}

/** A conta consegue enviar vídeo? (alguma permissão de vídeo foi concedida) */
export const tiktokCanPublish = (granted: string[]) => PUBLISH_SCOPES.some((s) => granted.includes(s));

export interface TiktokEndpoints {
  auth: string;
  token: string;
  userInfo: string;
  revoke: string;
}

export const TIKTOK: TiktokEndpoints = {
  auth: 'https://www.tiktok.com/v2/auth/authorize/',
  token: 'https://open.tiktokapis.com/v2/oauth/token/',
  userInfo: 'https://open.tiktokapis.com/v2/user/info/',
  revoke: 'https://open.tiktokapis.com/v2/oauth/revoke/',
};

export interface TiktokClient {
  clientKey: string;
  clientSecret: string;
  fetch?: typeof fetch;
  endpoints?: TiktokEndpoints;
}

const ep = (c: TiktokClient) => c.endpoints ?? TIKTOK;

export const createState = () => randomBytes(24).toString('base64url');

export function buildTiktokAuthUrl(c: { clientKey: string; redirectUri: string; state: string; scopes?: string[]; endpoints?: TiktokEndpoints }): string {
  const u = new URL((c.endpoints ?? TIKTOK).auth);
  u.search = new URLSearchParams({
    client_key: c.clientKey,
    scope: (c.scopes ?? tiktokScopes()).join(','),
    response_type: 'code',
    redirect_uri: c.redirectUri,
    state: c.state,
  }).toString();
  return u.toString();
}

export interface TiktokTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  openId: string;
  scopes: string[];
}

async function tokenRequest(c: TiktokClient, body: Record<string, string>): Promise<TiktokTokens> {
  let res: Response;
  try {
    res = await (c.fetch ?? fetch)(ep(c).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({ client_key: c.clientKey, client_secret: c.clientSecret, ...body }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch (e) {
    throw new ProviderError(`Falha de rede ao falar com o TikTok: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => null)) as Record<string, any> | null;
  // o TikTok pode responder erro com HTTP 200; não repassa a descrição bruta
  if (!res.ok || typeof j?.error === 'string' || typeof j?.access_token !== 'string') {
    throw new ProviderError(`O TikTok recusou a autorização (${typeof j?.error === 'string' ? j.error : `HTTP ${res.status}`}).`, res.status);
  }
  if (typeof j.refresh_token !== 'string' || typeof j.open_id !== 'string') {
    throw new ProviderError('Resposta do TikTok incompleta (sem refresh_token ou open_id).');
  }
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token,
    expiresAt: new Date(Date.now() + (Number(j.expires_in) || 86_400) * 1000),
    openId: j.open_id,
    scopes: typeof j.scope === 'string' ? j.scope.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
  };
}

export const exchangeTiktokCode = (c: TiktokClient, a: { code: string; redirectUri: string }) =>
  tokenRequest(c, { grant_type: 'authorization_code', code: a.code, redirect_uri: a.redirectUri });

/** O TikTok pode girar o refresh_token a cada renovação: sempre salvar o devolvido. */
export const refreshTiktokToken = (c: TiktokClient, refreshToken: string) =>
  tokenRequest(c, { grant_type: 'refresh_token', refresh_token: refreshToken });

export interface TiktokProfile {
  openId: string;
  displayName: string;
}

export async function fetchTiktokProfile(c: TiktokClient, accessToken: string): Promise<TiktokProfile> {
  const u = new URL(ep(c).userInfo);
  u.searchParams.set('fields', 'open_id,display_name');
  let res: Response;
  try {
    res = await (c.fetch ?? fetch)(u, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' });
  } catch (e) {
    throw new ProviderError(`Falha de rede ao falar com o TikTok: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => null)) as { data?: { user?: { open_id?: string; display_name?: string } }; error?: { code?: string } } | null;
  const code = j?.error?.code;
  if (!res.ok || (code && code !== 'ok')) throw new ProviderError(`O TikTok recusou a consulta do perfil (${code ?? `HTTP ${res.status}`}).`, res.status);
  const user = j?.data?.user;
  if (!user?.open_id) throw new ProviderError('O TikTok não devolveu os dados do perfil.');
  return { openId: user.open_id, displayName: user.display_name?.trim() || user.open_id };
}

/** Revoga o acesso (melhor esforço). */
export async function revokeTiktokToken(c: TiktokClient, token: string): Promise<boolean> {
  try {
    const res = await (c.fetch ?? fetch)(ep(c).revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_key: c.clientKey, client_secret: c.clientSecret, token }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}
