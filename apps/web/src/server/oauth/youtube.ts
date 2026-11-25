import { createHash, randomBytes } from 'node:crypto';
import { ProviderError } from '../ai/types';

/** Escopos pedidos: publicar vídeos + ler a identidade do canal conectado. */
export const YOUTUBE_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
] as const;

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  api: string;
}

export const GOOGLE: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  api: 'https://www.googleapis.com/youtube/v3',
};

export interface GoogleClient {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  endpoints?: GoogleEndpoints;
}

const b64url = (b: Buffer) => b.toString('base64url');

/** PKCE: o verifier fica só no cookie do navegador; o challenge vai na URL. */
export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()), state: b64url(randomBytes(24)) };
}

export function buildAuthUrl(c: { clientId: string; redirectUri: string; state: string; challenge: string; endpoints?: GoogleEndpoints }): string {
  const u = new URL((c.endpoints ?? GOOGLE).auth);
  u.search = new URLSearchParams({
    client_id: c.clientId,
    redirect_uri: c.redirectUri,
    response_type: 'code',
    scope: YOUTUBE_SCOPES.join(' '),
    state: c.state,
    code_challenge: c.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline', // pede refresh token
    prompt: 'consent select_account', // sempre devolve refresh token e deixa escolher a conta/canal
  }).toString();
  return u.toString();
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string[];
}

async function tokenRequest(client: GoogleClient, body: Record<string, string>): Promise<TokenSet> {
  const f = client.fetch ?? fetch;
  let res: Response;
  try {
    res = await f((client.endpoints ?? GOOGLE).token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...body }),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
  } catch (e) {
    throw new ProviderError(`Falha de rede ao falar com o Google: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || typeof j?.access_token !== 'string') {
    const code = typeof j?.error === 'string' ? j.error : `HTTP ${res.status}`;
    // não repassa o corpo bruto: pode conter detalhes do cliente
    throw new ProviderError(`Google recusou a autorização (${code}).`, res.status, false);
  }
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : undefined,
    expiresAt: new Date(Date.now() + (Number(j.expires_in) || 3600) * 1000),
    scopes: typeof j.scope === 'string' ? j.scope.split(' ') : [],
  };
}

export const exchangeCode = (client: GoogleClient, a: { code: string; verifier: string; redirectUri: string }) =>
  tokenRequest(client, { grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri });

/** Lança ProviderError com `status` 400 e mensagem "invalid_grant" quando o acesso foi revogado/expirou. */
export const refreshAccessToken = (client: GoogleClient, refreshToken: string) =>
  tokenRequest(client, { grant_type: 'refresh_token', refresh_token: refreshToken });

export interface YoutubeChannel {
  id: string;
  title: string;
  customUrl?: string;
}

/** Canal escolhido pelo usuário na tela de consentimento (channels?mine=true). */
export async function fetchMyChannel(client: GoogleClient, accessToken: string): Promise<YoutubeChannel> {
  const f = client.fetch ?? fetch;
  const res = await f(`${(client.endpoints ?? GOOGLE).api}/channels?part=snippet&mine=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  }).catch((e: Error) => {
    throw new ProviderError(`Falha de rede ao falar com o YouTube: ${e.message}`);
  });
  const j = (await res.json().catch(() => null)) as { items?: Array<{ id?: string; snippet?: { title?: string; customUrl?: string } }> } | null;
  if (!res.ok) throw new ProviderError(`O YouTube recusou a consulta do canal (HTTP ${res.status}).`, res.status);
  const ch = j?.items?.[0];
  if (!ch?.id) throw new ProviderError('Esta conta Google não tem um canal do YouTube. Crie o canal e tente de novo.');
  return { id: ch.id, title: ch.snippet?.title?.trim() || ch.id, customUrl: ch.snippet?.customUrl };
}

/** Revoga o acesso no Google (melhor esforço: erros não impedem a desconexão local). */
export async function revokeToken(client: GoogleClient, token: string): Promise<boolean> {
  try {
    const res = await (client.fetch ?? fetch)((client.endpoints ?? GOOGLE).revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });
    return res.ok;
  } catch {
    return false;
  }
}
