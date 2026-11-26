import { metaEndpoints } from '../../oauth/facebook';
import { PublishError, VIDEO_MIME_TYPES, type PublishAccount, type PublishAuth, type PublishInput, type PublishResult, type Publisher } from '../types';

export interface FacebookPublisherDeps {
  fetch?: typeof fetch;
  graph?: string;
}

const CODES: Record<number, string> = {
  10: 'Falta permissão para publicar nesta Página. Reconecte e aceite todas as permissões.',
  200: 'Sem permissão para publicar nesta Página. Confirme que você é administrador dela.',
  368: 'A Meta bloqueou temporariamente esta publicação (suspeita de spam).',
  4: 'A Meta limitou as chamadas do app por enquanto. Tente de novo mais tarde.',
  17: 'A Meta limitou as chamadas do app por enquanto. Tente de novo mais tarde.',
};

/** A Meta busca o vídeo pela URL pública (file_url): nada de arquivo passando pelo nosso servidor. */
export function facebookPublisher(deps: FacebookPublisherDeps = {}): Publisher {
  const f = deps.fetch ?? fetch;

  return {
    platform: 'FACEBOOK',

    validate(input: PublishInput) {
      const errs: string[] = [];
      const text = [input.title, input.description].filter(Boolean).join('\n\n');
      if (text.length > 60_000) errs.push('Facebook: o texto passa do limite.');
      if (!['video/mp4', 'video/quicktime'].includes(input.media.mimeType)) errs.push('Facebook: use vídeo MP4 ou MOV.');
      return errs;
    },

    async publish(account: PublishAccount, input: PublishInput, auth: PublishAuth): Promise<PublishResult> {
      if (!account.platformAccountId) throw new PublishError(`A página "${account.displayName}" não tem id do Facebook. Reconecte-a.`);
      const token = await auth.getToken();
      const graph = deps.graph ?? metaEndpoints().graph;

      const res = await f(`${graph}/${encodeURIComponent(account.platformAccountId)}/videos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          file_url: input.media.url,
          description: [input.title, input.description].filter(Boolean).join('\n\n'),
          ...(input.title ? { title: input.title.slice(0, 255) } : {}),
          published: input.visibility === 'PUBLIC' ? 'true' : 'false',
          access_token: token,
        }),
        signal: AbortSignal.timeout(280_000),
        redirect: 'error',
      }).catch((e: Error) => { throw new PublishError(`Falha de rede ao falar com a Meta: ${e.message}`); });

      const j = (await res.json().catch(() => null)) as { id?: string; error?: { code?: number } } | null;
      if (!res.ok || j?.error) {
        const code = j?.error?.code;
        if (code === 190) {
          await auth.onTokenRejected?.();
          return Promise.reject(new PublishError('A Meta recusou o acesso desta Página (token inválido). Reconecte-a em Contas sociais.'));
        }
        throw new PublishError((code && CODES[code]) || `A Meta recusou a publicação (código ${code ?? res.status}).`);
      }
      if (!j?.id) throw new PublishError('A Meta não confirmou a publicação.');
      return {
        platformPostId: j.id,
        url: `https://www.facebook.com/${account.platformAccountId}/videos/${j.id}`,
        note: input.visibility === 'PRIVATE' ? 'Enviado como não publicado: só os administradores da Página veem.' : undefined,
      };
    },
  };
}
