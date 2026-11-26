import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { verifyPayload } from '@/lib/session';
import { userMessage } from '@/server/errors';
import { appOrigin, connectFacebookPages, facebookRedirectUri } from '@/server/oauth/connect';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

/** Volta da Meta com ?code&state. Só a sessão do administrador que iniciou o fluxo consegue concluir. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  const done = (kind: 'ok' | 'error', msg: string) => {
    const res = NextResponse.redirect(new URL(`/accounts?${kind}=${encodeURIComponent(msg)}`, appOrigin(req.url)));
    res.cookies.delete({ name: 'sm_oauth', path: '/api/oauth' });
    return res;
  };

  if (url.searchParams.get('error')) {
    const denied = ['access_denied', 'user_denied'].includes(url.searchParams.get('error_reason') ?? url.searchParams.get('error') ?? '');
    return done('error', denied ? 'Conexão cancelada: você não autorizou o acesso.' : 'A Meta recusou a autorização.');
  }

  const saved = await verifyPayload(process.env.AUTH_SECRET, (await cookies()).get('sm_oauth')?.value);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!saved || saved.p !== 'facebook' || !state || state !== saved.state || !code) {
    return done('error', 'Conexão inválida ou expirada. Clique em Conectar de novo.');
  }

  try {
    const ws = await getWorkspace();
    const r = await connectFacebookPages({ workspaceId: ws.id, code, redirectUri: facebookRedirectUri(req.url), accountId: saved.accountId || undefined });
    const names = r.connected.map((c) => `"${c.page}"`).join(', ');
    return done('ok', `${r.connected.length} página(s) conectada(s): ${names}.${r.note ? ` ${r.note}` : ''}`);
  } catch (e) {
    return done('error', userMessage(e));
  }
}
