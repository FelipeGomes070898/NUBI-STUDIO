import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, verifySession } from '@/lib/session';

/** Toda rota exige sessão válida, exceto /login e as páginas legais. Falha fechada se AUTH_SECRET não estiver configurado. */
export async function middleware(req: NextRequest) {
  const ok = await verifySession(process.env.AUTH_SECRET, req.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}

export const config = { // Públicas: /login e as páginas legais exigidas pelas telas de consentimento (Google, Meta, TikTok).
matcher: ['/((?!login|privacidade|termos|_next/static|_next/image|favicon.ico).*)'] };
