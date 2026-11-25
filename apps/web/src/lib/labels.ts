import type { SocialPlatform, VideoFormat } from '@social-manager/db';

export const PLATFORMS: SocialPlatform[] = ['FACEBOOK', 'TIKTOK', 'YOUTUBE', 'INSTAGRAM'];
export const PLATFORM_LABEL: Record<SocialPlatform, string> = { FACEBOOK: 'Facebook', TIKTOK: 'TikTok', YOUTUBE: 'YouTube', INSTAGRAM: 'Instagram' };
export const PLATFORM_ICON: Record<SocialPlatform, string> = { FACEBOOK: 'f', TIKTOK: '♪', YOUTUBE: '▶', INSTAGRAM: '◎' };

export const FORMATS: VideoFormat[] = ['VERTICAL_9_16', 'HORIZONTAL_16_9', 'SQUARE_1_1', 'FLEXIBLE'];
export const FORMAT_LABEL: Record<VideoFormat, string> = {
  VERTICAL_9_16: 'Vertical 9:16',
  HORIZONTAL_16_9: 'Horizontal 16:9',
  SQUARE_1_1: 'Quadrado 1:1',
  FLEXIBLE: 'Flexível',
};

/** "3 Facebook • 1 TikTok • 1 YouTube" */
export function summarizePlatforms(accounts: Array<{ platform: SocialPlatform }>): string {
  if (accounts.length === 0) return 'Nenhuma conta';
  const counts = new Map<SocialPlatform, number>();
  for (const a of accounts) counts.set(a.platform, (counts.get(a.platform) ?? 0) + 1);
  return PLATFORMS.filter((p) => counts.has(p)).map((p) => `${counts.get(p)} ${PLATFORM_LABEL[p]}`).join(' • ');
}

export const fmtDate = (d: Date) =>
  new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(d) + ' UTC';
