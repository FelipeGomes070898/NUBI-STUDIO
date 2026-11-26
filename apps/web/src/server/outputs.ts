import { put } from '@vercel/blob';
import { mediaStore } from './storage';

export const blobEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

/**
 * Guarda um arquivo gerado. Com Vercel Blob configurado, vai para um endereço público não listado (sufixo aleatório):
 * necessário para publicar (Instagram/Facebook buscam o arquivo por URL). Sem Blob, cai no disco local (só desenvolvimento).
 */
export async function storeOutput(o: { key: string; bytes: Uint8Array; mime: string }): Promise<{ url?: string; storageKey?: string }> {
  if (blobEnabled()) {
    const r = await put(o.key, Buffer.from(o.bytes), { access: 'public', contentType: o.mime, addRandomSuffix: true });
    return { url: r.url };
  }
  await mediaStore.put(o.key, o.bytes);
  return { storageKey: o.key };
}
