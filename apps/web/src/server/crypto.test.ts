import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, secretHint } from './crypto';

const key = randomBytes(32).toString('base64');

describe('crypto', () => {
  it('faz round-trip e não deixa o segredo em claro', () => {
    const enc = encryptSecret('sk-super-secret-1234', key);
    expect(enc).not.toContain('super-secret');
    expect(decryptSecret(enc, key)).toBe('sk-super-secret-1234');
  });
  it('usa IV aleatório (mesmo texto → cifras diferentes)', () => {
    expect(encryptSecret('x', key)).not.toBe(encryptSecret('x', key));
  });
  it('falha com chave errada ou payload adulterado (GCM autentica)', () => {
    const enc = encryptSecret('abc', key);
    expect(() => decryptSecret(enc, randomBytes(32).toString('base64'))).toThrow();
    const [v, iv, tag, ct] = enc.split(':');
    const tampered = [v, iv, tag, Buffer.from('zzzz').toString('base64') + ct].join(':');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });
  it('rejeita chave ausente ou do tamanho errado', () => {
    expect(() => encryptSecret('a', 'curta')).toThrow(/32 bytes/);
    const prev = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret('a')).toThrow(/ENCRYPTION_KEY/);
    if (prev) process.env.ENCRYPTION_KEY = prev;
  });
  it('hint mostra só o final', () => {
    expect(secretHint('sk-abcdefgh1234')).toBe('••••1234');
    expect(secretHint('curta')).toBe('••••');
  });
});
