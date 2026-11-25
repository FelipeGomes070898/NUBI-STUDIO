import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM para chaves de API e tokens OAuth guardados no banco.
 * Formato: "v1:<iv b64>:<tag b64>:<ciphertext b64>". O prefixo de versão permite rotacionar o esquema.
 * Em produção, ENCRYPTION_KEY deve vir de um secret manager/KMS.
 */
const VERSION = 'v1';

function loadKey(raw = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error('ENCRYPTION_KEY não configurada. Gere uma com: openssl rand -base64 32');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY deve ter 32 bytes em base64 (openssl rand -base64 32).');
  return key;
}

export function encryptSecret(plaintext: string, rawKey?: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(rawKey), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(payload: string, rawKey?: string): string {
  const [version, iv, tag, ct] = payload.split(':');
  if (version !== VERSION || !iv || !tag || !ct) throw new Error('Segredo em formato desconhecido.');
  const decipher = createDecipheriv('aes-256-gcm', loadKey(rawKey), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Últimos 4 caracteres, para o usuário reconhecer a chave na UI sem expô-la. */
export function secretHint(secret: string): string {
  return secret.length <= 8 ? '••••' : `••••${secret.slice(-4)}`;
}
