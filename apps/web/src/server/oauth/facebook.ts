import { randomBytes } from 'node:crypto';
import { ProviderError } from '../ai/types';

/**
 * Permissões mínimas para publicar em Páginas. Páginas que você acessa só por um Portfólio Empresarial
 * podem exigir também `business_management`: configure com META_SCOPES (separadas por vírgula).
 */
export const DEFAULT_FACEBOOK_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement'];
/** Sem essa permissão concedida não dá para publicar; as demais podem ser recusadas pelo usuário. */
export const REQUIRED_FACEBOOK_SCOPE = 'pages_manage_posts';

/** Permissões extras do Instagram (conta Profissional ligada à Página). Só são pedidas no botão "Conectar Instagram". */
export const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish'];
export const REQUIRED_INSTAGRAM_SCOPE = 'instagram_content_publish';

export function facebookScopes(opts: { instagram?: boolean } = {}): string[] {
  const custom = process.env.META_SCOPES?.split(',').map((s) => s.trim()).filter(Boolean);
  const base = custom?.length ? custom : DEFAULT_FACEBOOK_SCOPES;
  if (!opts.instagram) return base;
  const extra = process.env.META_INSTAGRAM_SCOPES?.split(',').map((s) => s.trim()).filter(Boolean) ?? INSTAGRAM_SCOPES;
  return [...new Set([...base, ...extra])];
}

export interface MetaEndpoints {
  /** https://graph.facebook.com/vNN.N */
  graph: string;
  /** https://www.facebook.com/vNN.N/dialog/oauth */
  dialog: string;
}

/**
 * Versão da Graph API. A Meta aposenta versões antigas (e roteia chamadas para a mais antiga disponível),
 * então fica configurável: META_GRAPH_VERSION=v23.0.
 */
export function metaEndpoints(): MetaEndpoints {
  const v = process.env.META_GRAPH_VERSION || 'v23.0';
  return { graph: `https://graph.facebook.com/${v}`, dialog: `https://www.facebook.com/${v}/dialog/oauth` };
}

export interface MetaClient {
  appId: string;
  appSecret: string;
  fetch?: typeof fetch;
  endpoints?: MetaEndpoints;
}

const ep = (c: MetaClient) => c.endpoints ?? metaEndpoints();

/** O Facebook Login web não usa PKCE: a proteção é o `state` (cookie assinado) + segredo só no servidor. */
export const createState = () => randomBytes(24).toString('base64url');

export function buildFacebookAuthUrl(c: { appId: string; redirectUri: string; state: string; scopes?: string[]; instagram?: boolean; endpoints?: MetaEndpoints }): string {
  const u = new URL((c.endpoints ?? metaEndpoints()).dialog);
  u.search = new URLSearchParams({
    client_id: c.appId,
    redirect_uri: c.redirectUri,
    state: c.state,
    response_type: 'code',
    scope: (c.scopes ?? facebookScopes({ instagram: c.instagram })).join(','),
    auth_type: 'rerequest', // pede de novo permissões que o usuário recusou antes
  }).toString();
  return u.toString();
}

async function graphGet(c: MetaClient, urlOrPath: string, params: Record<string, string> = {}): Promise<Record<string, any>> {
  const base = ep(c).graph;
  const isAbs = /^https?:\/\//.test(urlOrPath);
  const url = new URL(isAbs ? urlOrPath : `${base}${urlOrPath}`);
  // paginação: só aceita seguir links do próprio Graph (nunca enviar token a outro host)
  if (isAbs && url.origin !== new URL(base).origin) throw new ProviderError('Resposta da Meta apontou para outro endereço; abortado.');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await (c.fetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  } catch (e) {
    throw new ProviderError(`Falha de rede ao falar com a Meta: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || j?.error) {
    const err = j?.error as { code?: number; type?: string; error_subcode?: number } | undefined;
    // não repassa a mensagem bruta (pode citar tokens/ids); só o código
    throw new ProviderError(`A Meta recusou a requisição (código ${err?.code ?? res.status}${err?.error_subcode ? `/${err.error_subcode}` : ''}).`, res.status);
  }
  return j ?? {};
}

export interface MetaToken {
  accessToken: string;
  expiresAt?: Date;
}

const toToken = (j: Record<string, any>): MetaToken => {
  if (typeof j.access_token !== 'string') throw new ProviderError('A Meta não devolveu o token de acesso.');
  return { accessToken: j.access_token, expiresAt: j.expires_in ? new Date(Date.now() + Number(j.expires_in) * 1000) : undefined };
};

export async function exchangeFacebookCode(c: MetaClient, a: { code: string; redirectUri: string }): Promise<MetaToken> {
  return toToken(await graphGet(c, '/oauth/access_token', { client_id: c.appId, client_secret: c.appSecret, redirect_uri: a.redirectUri, code: a.code }));
}

/** Troca o token curto (~1h) pelo de longa duração (~60 dias). É dele que saem os tokens de Página. */
export async function exchangeLongLived(c: MetaClient, shortToken: string): Promise<MetaToken> {
  return toToken(await graphGet(c, '/oauth/access_token', { grant_type: 'fb_exchange_token', client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: shortToken }));
}

export async function fetchGrantedScopes(c: MetaClient, userToken: string): Promise<string[]> {
  const j = await graphGet(c, '/me/permissions', { access_token: userToken });
  return (Array.isArray(j.data) ? j.data : []).filter((p: any) => p?.status === 'granted').map((p: any) => String(p.permission));
}

export interface FacebookPage {
  id: string;
  name: string;
  username?: string;
  /** Token da PÁGINA (derivado do token longo do usuário). */
  accessToken: string;
  tasks: string[];
  /** Conta Profissional do Instagram ligada à Página, quando houver. */
  instagram?: { id: string; username?: string; name?: string };
}

/** Páginas que o usuário liberou no diálogo da Meta, cada uma com o seu token. */
export async function fetchPages(c: MetaClient, userToken: string): Promise<FacebookPage[]> {
  const pages: FacebookPage[] = [];
  let next: string | null = null;
  for (let i = 0; i < 5; i++) {
    const j: Record<string, any> = next
      ? await graphGet(c, next)
      : await graphGet(c, '/me/accounts', { fields: 'id,name,username,access_token,tasks,instagram_business_account{id,username,name}', limit: '100', access_token: userToken });
    for (const p of Array.isArray(j.data) ? j.data : []) {
      if (typeof p?.id === 'string' && typeof p?.access_token === 'string') {
        const ig = p.instagram_business_account;
        pages.push({
          id: p.id, name: String(p.name ?? p.id).trim() || p.id, username: p.username ? String(p.username) : undefined, accessToken: p.access_token,
          tasks: Array.isArray(p.tasks) ? p.tasks.map(String) : [],
          instagram: typeof ig?.id === 'string' ? { id: ig.id, username: ig.username ? String(ig.username) : undefined, name: ig.name ? String(ig.name) : undefined } : undefined,
        });
      }
    }
    next = typeof j.paging?.next === 'string' ? j.paging.next : null;
    if (!next) break;
  }
  return pages;
}
