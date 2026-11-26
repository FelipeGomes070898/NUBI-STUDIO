import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { signPayload } from '@/lib/session';
import { userMessage } from '@/server/errors';
import { facebookRedirectUri, metaClientFromEnv } from '@/server/oauth/connect';
import { buildFacebookAuthUrl, createState } from '@/server/oauth/facebook';

export const dynamic = 'force-dynamic';

/** Inicia o login com Facebook. ?accountId= tenta ligar a Página a uma conta já cadastrada. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  let client;
  try {
    client = metaClientFromEnv();
  } catch (e) {
    return NextResponse.redirect(new URL(`/accounts?error=${encodeURIComponent(userMessage(e))}`, url.origin));
  }
  const state = createState();
  const cookie = await signPayload(process.env.AUTH_SECRET!, { p: 'facebook', state, accountId: url.searchParams.get('accountId') ?? '' }, 600);

  const res = NextResponse.redirect(buildFacebookAuthUrl({ appId: client.appId, redirectUri: facebookRedirectUri(req.url), state }));
  res.cookies.set('sm_oauth', cookie, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/oauth', maxAge: 600 });
  return res;
}
