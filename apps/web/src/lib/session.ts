/**
 * Sessão por cookie assinado (HMAC-SHA256, Web Crypto → funciona no middleware/Edge e no Node).
 * Formato: "<expira em s>.<assinatura hex>". Sem estado no servidor; troque AUTH_SECRET para invalidar tudo.
 */
export const SESSION_COOKIE = 'sm_session';
export const SESSION_TTL_S = 60 * 60 * 24 * 7;

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function signSession(secret: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_S;
  return `${exp}.${await hmac(secret, String(exp))}`;
}

export async function verifySession(secret: string | undefined, token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!secret || secret.length < 16 || !token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(now / 1000)) return false;
  return safeEqual(sig, await hmac(secret, exp));
}
