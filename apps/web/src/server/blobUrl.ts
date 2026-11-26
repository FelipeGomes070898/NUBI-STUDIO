import { UserError } from './errors';

/** Só aceitamos arquivos que estão no NOSSO armazenamento (Vercel Blob): o servidor baixa e a Meta/Google busca por URL. */
const BLOB_HOST = /^[a-z0-9-]+\.public\.blob\.vercel-storage\.com$/;

export function assertOwnBlobUrl(raw: string, what = 'arquivo'): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UserError(`Endereço do ${what} inválido.`);
  }
  if (u.protocol !== 'https:') throw new UserError(`Endereço do ${what} inválido.`);
  if (!BLOB_HOST.test(u.hostname)) throw new UserError(`O ${what} precisa ter sido enviado pelo próprio sistema.`);
  return u;
}

export const isOwnBlobUrl = (raw: string) => {
  try {
    assertOwnBlobUrl(raw);
    return true;
  } catch {
    return false;
  }
};
