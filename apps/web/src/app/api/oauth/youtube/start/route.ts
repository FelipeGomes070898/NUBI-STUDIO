import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { signPayload } from '@/lib/session';
import { googleClientFromEnv, youtubeRedirectUri } from '@/server/oauth/connect';
import { buildAuthUrl, createPkce } from '@/server/oauth/youtube';
import { userMessage } from '@/server/errors';

export const dynamic = 'force-dynamic';
const OAUTH_COOKIE = 'sm_oauth';

/** Inicia o login com Google. ?accountId= liga o canal a uma conta já cadastrada; sem ele, cria/reconecta pelo canal. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  const back = (msg: string) => NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(msg)}`, url.origin));

  let client;
  try {
    client = googleClientFromEnv();
  } catch (e) {
    return back(userMessage(e));
  }
  const accountId = url.searchParams.get('accountId') ?? '';
  const { verifier, challenge, state } = createPkce();
  const cookie = await signPayload(process.env.AUTH_SECRET!, { p: 'youtube', state, verifier, accountId }, 600);

  const res = NextResponse.redirect(buildAuthUrl({ clientId: client.clientId, redirectUri: youtubeRedirectUri(req.url), state, challenge }));
  res.cookies.set(OAUTH_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/oauth', maxAge: 600 });
  return res;
}
