import { createHash, timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, SESSION_TTL_S, signSession, verifySession } from './session';

/** Defesa em profundidade: o middleware já barra, mas toda server action revalida a sessão. */
export async function requireSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await verifySession(process.env.AUTH_SECRET, token))) redirect('/login');
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function passwordMatches(input: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(sha(input), sha(expected));
}

export function authConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD && (process.env.AUTH_SECRET?.length ?? 0) >= 16;
}

// Limitador simples em memória (por IP). Suficiente para 1 instância; use Redis ao escalar.
const attempts = new Map<string, { n: number; resetAt: number }>();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60 * 1000;

export async function loginRateLimited(): Promise<boolean> {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const now = Date.now();
  const cur = attempts.get(ip);
  if (!cur || cur.resetAt < now) return false;
  return cur.n >= MAX_ATTEMPTS;
}

export async function recordLoginFailure() {
  const h = await headers();
  const ip = h.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const now = Date.now();
  const cur = attempts.get(ip);
  if (!cur || cur.resetAt < now) attempts.set(ip, { n: 1, resetAt: now + WINDOW_MS });
  else cur.n++;
}

export async function startSession() {
  const token = await signSession(process.env.AUTH_SECRET!);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_S,
  });
}

export async function endSession() {
  (await cookies()).delete(SESSION_COOKIE);
}
