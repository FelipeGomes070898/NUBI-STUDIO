import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { verifyPayload } from '@/lib/session';
import { userMessage } from '@/server/errors';
import { appOrigin, connectYoutubeAccount, youtubeRedirectUri } from '@/server/oauth/connect';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

/** Volta do Google com ?code&state. Só a sessão do administrador que iniciou o fluxo consegue concluir. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  const done = (kind: 'ok' | 'error', msg: string) => {
    const res = NextResponse.redirect(new URL(`/accounts?${kind}=${encodeURIComponent(msg)}`, appOrigin(req.url)));
    res.cookies.delete({ name: 'sm_oauth', path: '/api/oauth' });
    return res;
  };

  if (url.searchParams.get('error')) {
    return done('error', url.searchParams.get('error') === 'access_denied' ? 'Conexão cancelada: você não autorizou o acesso.' : 'O Google recusou a autorização.');
  }

  const saved = await verifyPayload(process.env.AUTH_SECRET, (await cookies()).get('sm_oauth')?.value);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!saved || saved.p !== 'youtube' || !state || state !== saved.state || !code) {
    return done('error', 'Conexão inválida ou expirada. Clique em Conectar de novo.');
  }

  try {
    const ws = await getWorkspace();
    const r = await connectYoutubeAccount({
      workspaceId: ws.id,
      code,
      verifier: saved.verifier!,
      redirectUri: youtubeRedirectUri(req.url),
      accountId: saved.accountId || undefined,
    });
    return done('ok', `Canal "${r.channel.title}" conectado${r.created ? ' (conta criada)' : ''}.`);
  } catch (e) {
    return done('error', userMessage(e));
  }
}
