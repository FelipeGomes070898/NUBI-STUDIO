import { afterEach, describe, expect, it } from 'vitest';
import { buildFacebookAuthUrl, DEFAULT_FACEBOOK_SCOPES, facebookScopes, INSTAGRAM_SCOPES, metaEndpoints } from './facebook';

describe('login com Facebook', () => {
  const save = { s: process.env.META_SCOPES, v: process.env.META_GRAPH_VERSION };
  afterEach(() => { process.env.META_SCOPES = save.s; process.env.META_GRAPH_VERSION = save.v; if (save.s === undefined) delete process.env.META_SCOPES; if (save.v === undefined) delete process.env.META_GRAPH_VERSION; });

  it('monta a URL do diálogo com escopos, state e redirect exato, sem segredo', () => {
    const u = new URL(buildFacebookAuthUrl({ appId: '123', redirectUri: 'https://app.test/api/oauth/facebook/callback', state: 'st' }));
    expect(u.origin + u.pathname).toBe('https://www.facebook.com/v23.0/dialog/oauth');
    expect(u.searchParams.get('client_id')).toBe('123');
    expect(u.searchParams.get('redirect_uri')).toBe('https://app.test/api/oauth/facebook/callback');
    expect(u.searchParams.get('state')).toBe('st');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe(DEFAULT_FACEBOOK_SCOPES.join(','));
    expect(u.searchParams.get('auth_type')).toBe('rerequest');
    expect(u.search).not.toMatch(/secret/i);
  });

  it('escopos e versão da Graph API são configuráveis por ambiente', () => {
    process.env.META_SCOPES = ' pages_show_list , business_management ';
    expect(facebookScopes()).toEqual(['pages_show_list', 'business_management']);
    process.env.META_GRAPH_VERSION = 'v99.0';
    expect(metaEndpoints()).toEqual({ graph: 'https://graph.facebook.com/v99.0', dialog: 'https://www.facebook.com/v99.0/dialog/oauth' });
  });

  it('Instagram é opt-in: só o botão do Instagram pede as permissões extras (o do Facebook não muda)', () => {
    expect(facebookScopes()).toEqual(DEFAULT_FACEBOOK_SCOPES);
    expect(facebookScopes({ instagram: true })).toEqual([...DEFAULT_FACEBOOK_SCOPES, ...INSTAGRAM_SCOPES]);
    const plain = new URL(buildFacebookAuthUrl({ appId: '1', redirectUri: 'https://a/cb', state: 's' }));
    const ig = new URL(buildFacebookAuthUrl({ appId: '1', redirectUri: 'https://a/cb', state: 's', instagram: true }));
    expect(plain.searchParams.get('scope')).not.toContain('instagram');
    expect(ig.searchParams.get('scope')).toContain('instagram_content_publish');
    process.env.META_INSTAGRAM_SCOPES = 'instagram_basic';
    expect(facebookScopes({ instagram: true })).toEqual([...DEFAULT_FACEBOOK_SCOPES, 'instagram_basic']);
    delete process.env.META_INSTAGRAM_SCOPES;
  });
});
