import type { PublicationKind, SocialPlatform } from '@social-manager/db';

export interface PublishMedia {
  /** URL pública (não listada) do arquivo. */
  url: string;
  sizeBytes: number;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  durationSec?: number | null;
}

export interface PublishInput {
  /** POST = vídeo no feed/canal; STORY = story (só Facebook e Instagram). */
  kind: PublicationKind;
  title: string;
  description: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  media: PublishMedia;
}

export interface PublishAccount {
  id: string;
  displayName: string;
  platformAccountId: string | null;
  scopes: string[];
}

export interface PublishAuth {
  getToken(): Promise<string>;
  /** A plataforma recusou o token (revogado/expirado): o publicador avisa para a conta pedir reconexão. */
  onTokenRejected?(): Promise<void>;
}

export interface PublishResult {
  platformPostId: string;
  url?: string;
  /** Aviso não fatal (ex.: a plataforma reduziu a visibilidade). */
  note?: string;
}

export interface Publisher {
  readonly platform: SocialPlatform;
  /** Erros que impedem publicar (antes de agendar). Lista vazia = ok. */
  validate(input: PublishInput): string[];
  publish(account: PublishAccount, input: PublishInput, auth: PublishAuth): Promise<PublishResult>;
}

/** Erro com mensagem segura para mostrar ao usuário (sem tokens nem corpo bruto da plataforma). */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];

export const MB = 1024 * 1024;

export const NO_STORY_MESSAGE = (platformLabel: string) => `${platformLabel}: não tem story. Story só existe no Facebook e no Instagram.`;
