import { describe, expect, it } from 'vitest';
import { signPayload, signSession, verifyPayload, verifySession } from './session';

const secret = 'a-very-long-secret-for-tests-1234';

describe('session', () => {
  it('aceita token válido e rejeita adulterado, expirado ou com outro segredo', async () => {
    const t = await signSession(secret);
    expect(await verifySession(secret, t)).toBe(true);
    expect(await verifySession(secret, t.replace(/.$/, (c) => (c === '0' ? '1' : '0')))).toBe(false);
    const [exp, sig] = t.split('.');
    expect(await verifySession(secret, `${Number(exp) + 999}.${sig}`)).toBe(false);
    expect(await verifySession('outro-segredo-bem-longo-9999', t)).toBe(false);
    expect(await verifySession(secret, t, Date.now() + 8 * 24 * 3600 * 1000)).toBe(false);
  });
  it('sem segredo configurado (ou fraco) nunca autentica — falha fechada', async () => {
    const t = await signSession(secret);
    expect(await verifySession(undefined, t)).toBe(false);
    expect(await verifySession('curto', t)).toBe(false);
    expect(await verifySession(secret, undefined)).toBe(false);
    expect(await verifySession(secret, 'lixo')).toBe(false);
  });
});

describe('payload assinado (estado do OAuth)', () => {
  it('faz round-trip e rejeita adulteração, expiração e segredo errado', async () => {
    const t = await signPayload(secret, { state: 'abc', v: 'xyz' }, 600);
    expect(await verifyPayload(secret, t)).toMatchObject({ state: 'abc', v: 'xyz' });
    const [body, sig] = t.split('.');
    expect(await verifyPayload(secret, `${body}x.${sig}`)).toBeNull();
    expect(await verifyPayload('outro-segredo-bem-longo-9999', t)).toBeNull();
    expect(await verifyPayload(secret, t, Date.now() + 601_000)).toBeNull();
    expect(await verifyPayload(undefined, t)).toBeNull();
    expect(await verifyPayload(secret, 'lixo')).toBeNull();
  });
});
