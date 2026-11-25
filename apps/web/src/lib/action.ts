import { redirect } from 'next/navigation';
import { requireSession } from './auth';
import { userMessage } from '@/server/errors';
import { getWorkspace } from '@/server/workspace';

/**
 * Envelope de server actions: exige sessão, executa, e volta para a página com ?ok= ou ?error=.
 * `fn` NÃO deve chamar redirect() (o redirect lança e seria capturado aqui).
 */
export async function run(
  path: string,
  fn: (workspaceId: string) => Promise<string | void | { message: string; to: string }>,
): Promise<never> {
  await requireSession();
  const sep = path.includes('?') ? '&' : '?';
  let target = path;
  try {
    const ws = await getWorkspace();
    const res = await fn(ws.id);
    if (typeof res === 'string') target = `${path}${sep}ok=${encodeURIComponent(res)}`;
    else if (res) target = `${res.to}${res.to.includes('?') ? '&' : '?'}ok=${encodeURIComponent(res.message)}`;
  } catch (e) {
    target = `${path}${sep}error=${encodeURIComponent(userMessage(e))}`;
  }
  redirect(target);
}
