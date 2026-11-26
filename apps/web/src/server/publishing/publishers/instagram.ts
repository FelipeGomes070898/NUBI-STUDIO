import { metaEndpoints } from '../../oauth/facebook';
import { PublishError, type PublishAccount, type PublishAuth, type PublishInput, type PublishResult, type Publisher } from '../types';

export interface InstagramPublisherDeps {
  fetch?: typeof fetch;
  graph?: string;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

const CODES: Record<number, string> = {
  10: 'Falta permissão para publicar no Instagram. Reconecte e aceite todas as permissões.',
  200: 'Sem permissão para publicar nesta conta do Instagram.',
  4: 'A Meta limitou as chamadas do app por enquanto. Tente de novo mais tarde.',
  17: 'A Meta limitou as chamadas do app por enquanto. Tente de novo mais tarde.',
  9007: 'O Instagram ainda está processando o vídeo. Tente de novo em alguns minutos.',
  2207026: 'O Instagram não aceitou o formato do vídeo (use MP4/MOV H.264 com áudio AAC).',
  2207082: 'O Instagram recusou este vídeo. Confira o tamanho, a duração e o formato.',
  2207051: 'O Instagram bloqueou esta publicação (suspeita de spam).',
};

/**
 * Instagram Graph API (conta Profissional ligada a uma Página): cria o contêiner de mídia a partir da URL pública,
 * espera o processamento e publica. Post de vídeo no feed = Reels; STORY = story em vídeo.
 */
export function instagramPublisher(deps: InstagramPublisherDeps = {}): Publisher {
  const f = deps.fetch ?? fetch;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function call(method: 'GET' | 'POST', url: string, params: Record<string, string>, auth: PublishAuth): Promise<Record<string, any>> {
    const u = new URL(url);
    let init: RequestInit = { method, signal: AbortSignal.timeout(60_000), redirect: 'error' };
    if (method === 'GET') for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    else init = { ...init, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) };
    const res = await f(u, init).catch((e: Error) => { throw new PublishError(`Falha de rede ao falar com a Meta: ${e.message}`); });
    const j = (await res.json().catch(() => null)) as Record<string, any> | null;
    if (!res.ok || j?.error) {
      const code = (j?.error?.error_subcode as number | undefined) ?? (j?.error?.code as number | undefined);
      if (j?.error?.code === 190) {
        await auth.onTokenRejected?.();
        throw new PublishError('A Meta recusou o acesso desta conta (token inválido). Reconecte em Contas sociais.');
      }
      throw new PublishError((code && CODES[code]) || `A Meta recusou a publicação no Instagram (código ${j?.error?.code ?? res.status}${j?.error?.error_subcode ? `/${j.error.error_subcode}` : ''}).`);
    }
    return j ?? {};
  }

  return {
    platform: 'INSTAGRAM',

    validate(input: PublishInput) {
      const errs: string[] = [];
      if (input.visibility === 'PRIVATE') errs.push('Instagram: não existe publicação privada pela API (o post sai público).');
      if (![ 'video/mp4', 'video/quicktime' ].includes(input.media.mimeType)) errs.push('Instagram: use vídeo MP4 ou MOV.');
      const caption = [input.title, input.description].filter(Boolean).join('\n\n');
      if (input.kind === 'POST' && caption.length > 2200) errs.push('Instagram: legenda passa de 2200 caracteres.');
      const d = input.media.durationSec;
      if (d && input.kind === 'STORY' && d > 60) errs.push('Instagram: story em vídeo aceita até 60 segundos.');
      if (d && d < 3) errs.push('Instagram: o vídeo precisa ter pelo menos 3 segundos.');
      return errs;
    },

    async publish(account: PublishAccount, input: PublishInput, auth: PublishAuth): Promise<PublishResult> {
      if (!account.platformAccountId) throw new PublishError(`A conta "${account.displayName}" não tem id do Instagram. Reconecte-a.`);
      const token = await auth.getToken();
      const graph = deps.graph ?? metaEndpoints().graph;
      const igId = encodeURIComponent(account.platformAccountId);
      const story = input.kind === 'STORY';
      const caption = [input.title, input.description].filter(Boolean).join('\n\n');

      const created = await call('POST', `${graph}/${igId}/media`, {
        media_type: story ? 'STORIES' : 'REELS',
        video_url: input.media.url,
        ...(story ? {} : { caption, share_to_feed: 'true' }),
        access_token: token,
      }, auth);
      const creationId = created.id as string | undefined;
      if (!creationId) throw new PublishError('O Instagram não iniciou o envio do vídeo.');

      // o vídeo é baixado e processado de forma assíncrona
      let ready = false;
      for (let i = 0; i < (deps.pollAttempts ?? 60); i++) {
        const st = await call('GET', `${graph}/${encodeURIComponent(creationId)}`, { fields: 'status_code', access_token: token }, auth);
        if (st.status_code === 'FINISHED') { ready = true; break; }
        if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new PublishError(`O Instagram não conseguiu processar o vídeo (${st.status_code}). Confira formato (MP4/MOV H.264 + AAC), tamanho e duração.`);
        await sleep(deps.pollIntervalMs ?? 5000);
      }
      if (!ready) throw new PublishError('O Instagram demorou demais para processar o vídeo. Tente de novo mais tarde.');

      const pub = await call('POST', `${graph}/${igId}/media_publish`, { creation_id: creationId, access_token: token }, auth);
      const mediaId = pub.id as string | undefined;
      if (!mediaId) throw new PublishError('O Instagram não confirmou a publicação.');

      let url: string | undefined;
      if (!story) {
        const info = await call('GET', `${graph}/${encodeURIComponent(mediaId)}`, { fields: 'permalink', access_token: token }, auth).catch(() => ({} as Record<string, any>));
        url = typeof info.permalink === 'string' ? info.permalink : undefined;
      }
      return { platformPostId: mediaId, url };
    },
  };
}
