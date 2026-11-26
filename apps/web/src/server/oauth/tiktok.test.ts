import { afterEach, describe, expect, it } from 'vitest';
import { buildTiktokAuthUrl, DEFAULT_TIKTOK_SCOPES, tiktokCanPublish, tiktokScopes } from './tiktok';

describe('login com TikTok', () => {
  const save = process.env.TIKTOK_SCOPES;
  afterEach(() => { process.env.TIKTOK_SCOPES = save; if (save === undefined) delete process.env.TIKTOK_SCOPES; });

  it('monta a URL de autorização com client_key, escopos, state e redirect exato, sem segredo', () => {
    const u = new URL(buildTiktokAuthUrl({ clientKey: 'ck123', redirectUri: 'https://app.test/api/oauth/tiktok/callback', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/');
    expect(u.searchParams.get('client_key')).toBe('ck123');
    expect(u.searchParams.get('scope')).toBe(DEFAULT_TIKTOK_SCOPES.join(','));
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.test/api/oauth/tiktok/callback');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.search).not.toMatch(/secret/i);
  });

  it('escopos configuráveis por ambiente', () => {
    process.env.TIKTOK_SCOPES = ' user.info.basic , video.upload ';
    expect(tiktokScopes()).toEqual(['user.info.basic', 'video.upload']);
  });

  it('só publica se alguma permissão de vídeo foi concedida', () => {
    expect(tiktokCanPublish(['user.info.basic'])).toBe(false);
    expect(tiktokCanPublish(['user.info.basic', 'video.upload'])).toBe(true);
    expect(tiktokCanPublish(['video.publish'])).toBe(true);
  });
});
