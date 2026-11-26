import { readExact } from '../stream';
import { MB, PublishError, VIDEO_MIME_TYPES, type PublishAccount, type PublishAuth, type PublishInput, type PublishResult, type Publisher } from '../types';

const API = 'https://open.tiktokapis.com';

export interface TiktokPublisherDeps {
  fetch?: typeof fetch;
  base?: string;
  /** Tamanho dos pedaços do envio (o TikTok aceita 5–64 MB; o último pode ter até 128 MB). */
  chunkSize?: number;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

const CODES: Record<string, string> = {
  unaudited_client_can_only_post_to_private_accounts: 'O app do TikTok ainda não foi auditado: por enquanto só publica como privado.',
  spam_risk_too_many_posts: 'O TikTok limitou o número de posts deste perfil por hoje.',
  spam_risk_user_banned_from_posting: 'O TikTok bloqueou este perfil de postar.',
  scope_not_authorized: 'Falta permissão de vídeo no TikTok. Reconecte e aceite as permissões.',
  reached_active_user_cap: 'O app do TikTok atingiu o limite de usuários ativos.',
  url_ownership_unverified: 'O TikTok não verificou a propriedade do domínio do app.',
  privacy_level_option_mismatch: 'O TikTok não aceitou a visibilidade pedida para este perfil.',
  rate_limit_exceeded: 'O TikTok limitou as chamadas por enquanto. Tente de novo em alguns minutos.',
};

export function tiktokPublisher(deps: TiktokPublisherDeps = {}): Publisher {
  const f = deps.fetch ?? fetch;
  const base = deps.base ?? API;
  const chunk = deps.chunkSize ?? 10 * MB;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function call(path: string, token: string, body: unknown, auth: PublishAuth): Promise<any> {
    const res = await f(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    }).catch((e: Error) => { throw new PublishError(`Falha de rede ao falar com o TikTok: ${e.message}`); });
    const j = (await res.json().catch(() => null)) as { data?: any; error?: { code?: string } } | null;
    const code = j?.error?.code;
    if (!res.ok || (code && code !== 'ok')) {
      if (code === 'access_token_invalid' || code === 'access_token_expired' || res.status === 401) {
        await auth.onTokenRejected?.();
        throw new PublishError('O TikTok recusou o acesso deste perfil. Reconecte-o em Contas sociais.');
      }
      throw new PublishError(CODES[code ?? ''] ?? `O TikTok recusou a requisição (${code ?? `HTTP ${res.status}`}).`);
    }
    return j?.data ?? {};
  }

  return {
    platform: 'TIKTOK',

    validate(input: PublishInput) {
      const errs: string[] = [];
      const caption = [input.title, input.description].filter(Boolean).join('\n\n');
      if (caption.length > 2200) errs.push('TikTok: título + legenda passam de 2200 caracteres.');
      if (!VIDEO_MIME_TYPES.includes(input.media.mimeType)) errs.push('TikTok: use vídeo MP4, MOV ou WebM.');
      if (input.media.sizeBytes > 4 * 1024 * MB) errs.push('TikTok: o vídeo passa de 4 GB.');
      return errs;
    },

    async publish(account: PublishAccount, input: PublishInput, auth: PublishAuth): Promise<PublishResult> {
      const direct = account.scopes.includes('video.publish');
      if (!direct && !account.scopes.includes('video.upload')) {
        throw new PublishError(`O perfil "${account.displayName}" foi conectado sem permissão de vídeo. Reconecte-o depois que o TikTok liberar a Content Posting API no app.`);
      }
      const token = await auth.getToken();
      const { media } = input;
      let note: string | undefined;
      let privacy = 'SELF_ONLY';

      if (direct) {
        const info = await call('/v2/post/publish/creator_info/query/', token, {}, auth);
        const options: string[] = Array.isArray(info.privacy_level_options) ? info.privacy_level_options : [];
        const wanted = input.visibility === 'PUBLIC' ? 'PUBLIC_TO_EVERYONE' : 'SELF_ONLY';
        privacy = options.includes(wanted) ? wanted : options.includes('SELF_ONLY') ? 'SELF_ONLY' : (options[0] ?? 'SELF_ONLY');
        if (privacy !== wanted) note = `O TikTok só permitiu a visibilidade "${privacy}" para este perfil (app sem auditoria ou perfil privado).`;
        const max = Number(info.max_video_post_duration_sec);
        if (media.durationSec && max && media.durationSec > max) throw new PublishError(`O vídeo (${Math.round(media.durationSec)}s) passa do máximo de ${max}s deste perfil.`);
      } else {
        note = 'Enviado como rascunho: abra o app do TikTok, na caixa de entrada, para finalizar e publicar.';
      }

      // pedaços: o último absorve o resto da divisão
      const size = media.sizeBytes;
      const chunkSize = size < chunk ? size : chunk;
      const total = Math.max(1, Math.floor(size / chunkSize));
      const sizes = Array.from({ length: total }, (_, i) => (i < total - 1 ? chunkSize : size - chunkSize * (total - 1)));

      const caption = [input.title, input.description].filter(Boolean).join('\n\n');
      const init = await call(direct ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/', token, {
        ...(direct ? { post_info: { title: caption, privacy_level: privacy, disable_duet: false, disable_comment: false, disable_stitch: false } } : {}),
        source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunkSize, total_chunk_count: total },
      }, auth);
      const publishId = init.publish_id as string | undefined;
      const uploadUrl = init.upload_url as string | undefined;
      if (!publishId || !uploadUrl) throw new PublishError('O TikTok não devolveu o endereço de envio.');

      const src = await f(media.url, { signal: AbortSignal.timeout(30_000), redirect: 'error' }).catch((e: Error) => { throw new PublishError(`Não foi possível ler o vídeo no armazenamento: ${e.message}`); });
      if (!src.ok || !src.body) throw new PublishError(`Não foi possível ler o vídeo no armazenamento (HTTP ${src.status}).`);

      let start = 0;
      try {
        for await (const part of readExact(src.body, sizes)) {
          const end = start + part.length - 1;
          const res = await f(uploadUrl, {
            method: 'PUT',
            headers: { 'Content-Type': media.mimeType, 'Content-Length': String(part.length), 'Content-Range': `bytes ${start}-${end}/${size}` },
            body: part as unknown as BodyInit,
            signal: AbortSignal.timeout(120_000),
            redirect: 'error',
          });
          if (res.status !== 201 && res.status !== 206 && !res.ok) throw new PublishError(`O TikTok recusou um pedaço do vídeo (HTTP ${res.status}).`);
          start = end + 1;
        }
      } catch (e) {
        if (e instanceof PublishError) throw e;
        throw new PublishError(`Falha durante o envio ao TikTok: ${(e as Error).message}`);
      }

      // confirmação: o TikTok processa de forma assíncrona
      const attempts = deps.pollAttempts ?? 20;
      for (let i = 0; i < attempts; i++) {
        const st = await call('/v2/post/publish/status/fetch/', token, { publish_id: publishId }, auth);
        if (st.status === 'FAILED') throw new PublishError(`O TikTok falhou ao processar o vídeo (${st.fail_reason ?? 'motivo não informado'}).`);
        if (st.status === 'PUBLISH_COMPLETE' || st.status === 'SEND_TO_USER_INBOX') {
          const postId = Array.isArray(st.publicaly_available_post_id) ? String(st.publicaly_available_post_id[0] ?? '') : '';
          return { platformPostId: postId || publishId, note };
        }
        await sleep(deps.pollIntervalMs ?? 3000);
      }
      return { platformPostId: publishId, note: [note, 'O TikTok ainda está processando o vídeo; confira no app em alguns minutos.'].filter(Boolean).join(' ') };
    },
  };
}
