import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { signPayload } from '@/lib/session';
import { userMessage } from '@/server/errors';
import { tiktokClientFromEnv, tiktokRedirectUri } from '@/server/oauth/connect';
import { buildTiktokAuthUrl, createState } from '@/server/oauth/tiktok';

export const dynamic = 'force-dynamic';

/** Inicia o login com TikTok. ?accountId= liga o perfil a uma conta já cadastrada. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  let client;
  try {
    client = tiktokClientFromEnv();
  } catch (e) {
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(userMessage(e))}`, url.origin));
  }
  const state = createState();
  const cookie = await signPayload(process.env.AUTH_SECRET!, { p: 'tiktok', state, accountId: url.searchParams.get('accountId') ?? '' }, 600);

  const res = NextResponse.redirect(buildTiktokAuthUrl({ clientKey: client.clientKey, redirectUri: tiktokRedirectUri(req.url), state }));
  res.cookies.set('sm_oauth', cookie, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/oauth', maxAge: 600 });
  return res;
}
