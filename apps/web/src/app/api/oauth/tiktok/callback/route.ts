import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth';
import { verifyPayload } from '@/lib/session';
import { userMessage } from '@/server/errors';
import { appOrigin, connectTiktokAccount, tiktokRedirectUri } from '@/server/oauth/connect';
import { getWorkspace } from '@/server/workspace';

export const dynamic = 'force-dynamic';

/** Volta do TikTok com ?code&state. Só a sessão do administrador que iniciou o fluxo consegue concluir. */
export async function GET(req: Request) {
  await requireSession();
  const url = new URL(req.url);
  const done = (kind: 'ok' | 'error', msg: string) => {
    const res = NextResponse.redirect(new URL(`/accounts?${kind}=${encodeURIComponent(msg)}`, appOrigin(req.url)));
    res.cookies.delete({ name: 'sm_oauth', path: '/api/oauth' });
    return res;
  };

  const err = url.searchParams.get('error');
  if (err) {
    return done('error', err === 'access_denied' ? 'Conexão cancelada: você não autorizou o acesso.' : `O TikTok recusou a autorização (${err}).`);
  }

  const saved = await verifyPayload(process.env.AUTH_SECRET, (await cookies()).get('sm_oauth')?.value);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!saved || saved.p !== 'tiktok' || !state || state !== saved.state || !code) {
    return done('error', 'Conexão inválida ou expirada. Clique em Conectar de novo.');
  }

  try {
    const ws = await getWorkspace();
    const r = await connectTiktokAccount({ workspaceId: ws.id, code, redirectUri: tiktokRedirectUri(req.url), accountId: saved.accountId || undefined });
    const warn = r.canPublish ? '' : ' Atenção: o TikTok não liberou permissão de vídeo, então esta conta ainda não consegue publicar.';
    return done('ok', `Perfil "${r.profile.displayName}" conectado${r.created ? ' (conta criada)' : ''}.${warn}`);
  } catch (e) {
    return done('error', userMessage(e));
  }
}
