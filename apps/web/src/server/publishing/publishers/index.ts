import type { SocialPlatform } from '@social-manager/db';
import { PublishError, type Publisher } from '../types';
import { facebookPublisher } from './facebook';
import { instagramPublisher } from './instagram';
import { tiktokPublisher } from './tiktok';
import { youtubePublisher } from './youtube';

export type PublisherRegistry = Partial<Record<SocialPlatform, Publisher>>;

export const defaultPublishers = (): PublisherRegistry => ({
  YOUTUBE: youtubePublisher(),
  FACEBOOK: facebookPublisher(),
  INSTAGRAM: instagramPublisher(),
  TIKTOK: tiktokPublisher(),
});

export function publisherFor(registry: PublisherRegistry, platform: SocialPlatform): Publisher {
  const p = registry[platform];
  if (!p) throw new PublishError(`Ainda não há publicação para ${platform}.`);
  return p;
}
