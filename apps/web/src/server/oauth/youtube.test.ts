import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAuthUrl, createPkce, YOUTUBE_SCOPES } from './youtube';

describe('login com Google (YouTube)', () => {
  it('monta a URL com PKCE S256, escopos, offline e redirect exato', () => {
    const p = createPkce();
    const u = new URL(buildAuthUrl({ clientId: 'cid', redirectUri: 'https://app.test/api/oauth/youtube/callback', state: p.state, challenge: p.challenge }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.test/api/oauth/youtube/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe(YOUTUBE_SCOPES.join(' '));
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toContain('consent');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(p.state);
    expect(u.searchParams.has('client_secret')).toBe(false);
  });

  it('o challenge é o SHA-256 do verifier e cada fluxo é único', () => {
    const a = createPkce(), b = createPkce();
    expect(a.challenge).toBe(createHash('sha256').update(a.verifier).digest('base64url'));
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier.length).toBeGreaterThanOrEqual(43); // mínimo do RFC 7636
  });
});
