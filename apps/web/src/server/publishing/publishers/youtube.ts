import { PublishError, VIDEO_MIME_TYPES, type PublishAccount, type PublishAuth, type PublishInput, type PublishResult, type Publisher } from '../types';

const UPLOAD_BASE = 'https://www.googleapis.com/upload/youtube/v3';

export interface YoutubePublisherDeps {
  fetch?: typeof fetch;
  uploadBase?: string;
}

const REASONS: Record<string, string> = {
  quotaExceeded: 'A cota diária da API do YouTube acabou. Tente amanhã ou peça aumento de cota ao Google.',
  uploadLimitExceeded: 'Este canal atingiu o limite de envios do YouTube por enquanto.',
  forbidden: 'O YouTube recusou o envio (sem permissão neste canal).',
  youtubeSignupRequired: 'Esta conta Google não tem canal do YouTube.',
  invalidTitle: 'O YouTube recusou o título.',
  invalidDescription: 'O YouTube recusou a descrição.',
};

/** Envio retomável: cria a sessão e transmite o vídeo direto do armazenamento (sem carregar o arquivo na memória). */
export function youtubePublisher(deps: YoutubePublisherDeps = {}): Publisher {
  const f = deps.fetch ?? fetch;
  const base = deps.uploadBase ?? UPLOAD_BASE;

  return {
    platform: 'YOUTUBE',

    validate(input: PublishInput) {
      const errs: string[] = [];
      if (!input.title.trim()) errs.push('YouTube: o título é obrigatório.');
      if (input.title.length > 100) errs.push('YouTube: o título passa de 100 caracteres.');
      if (/[<>]/.test(input.title + input.description)) errs.push('YouTube: título e descrição não aceitam os caracteres < e >.');
      if (Buffer.byteLength(input.description, 'utf8') > 5000) errs.push('YouTube: a descrição passa de 5000 bytes.');
      if (!VIDEO_MIME_TYPES.includes(input.media.mimeType)) errs.push('YouTube: formato de vídeo não aceito (use MP4, MOV ou WebM).');
      return errs;
    },

    async publish(_account: PublishAccount, input: PublishInput, auth: PublishAuth): Promise<PublishResult> {
      const token = await auth.getToken();
      const { media } = input;
      const privacy = input.visibility === 'PUBLIC' ? 'public' : 'private';

      const init = await f(`${base}/videos?uploadType=resumable&part=snippet,status`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Length': String(media.sizeBytes),
          'X-Upload-Content-Type': media.mimeType,
        },
        body: JSON.stringify({
          snippet: { title: input.title.trim(), description: input.description, categoryId: '22' },
          status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
        }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      }).catch((e: Error) => { throw new PublishError(`Falha de rede ao falar com o YouTube: ${e.message}`); });

      if (!init.ok) throw await failure(init, auth);
      const uploadUrl = init.headers.get('location');
      if (!uploadUrl) throw new PublishError('O YouTube não devolveu o endereço de envio.');

      const src = await f(media.url, { signal: AbortSignal.timeout(30_000), redirect: 'error' }).catch((e: Error) => { throw new PublishError(`Não foi possível ler o vídeo no armazenamento: ${e.message}`); });
      if (!src.ok || !src.body) throw new PublishError(`Não foi possível ler o vídeo no armazenamento (HTTP ${src.status}).`);

      const put = await f(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': media.mimeType, 'Content-Length': String(media.sizeBytes) },
        body: src.body,
        // @ts-expect-error — `duplex` é exigido pelo Node para corpo em stream e ainda não está nos tipos do DOM
        duplex: 'half',
        signal: AbortSignal.timeout(280_000),
        redirect: 'error',
      }).catch((e: Error) => { throw new PublishError(`Falha durante o envio ao YouTube: ${e.message}`); });

      if (!put.ok) throw await failure(put, auth);
      const j = (await put.json().catch(() => null)) as { id?: string; status?: { privacyStatus?: string } } | null;
      if (!j?.id) throw new PublishError('O YouTube não confirmou o envio do vídeo.');

      const note =
        privacy === 'public' && j.status?.privacyStatus && j.status.privacyStatus !== 'public'
          ? `O YouTube deixou o vídeo como "${j.status.privacyStatus}". Projetos de API ainda sem auditoria do Google ficam privados.`
          : undefined;
      return { platformPostId: j.id, url: `https://www.youtube.com/watch?v=${j.id}`, note };
    },
  };
}

async function failure(res: Response, auth: PublishAuth): Promise<PublishError> {
  const j = (await res.json().catch(() => null)) as { error?: { errors?: Array<{ reason?: string }>; status?: string } } | null;
  const reason = j?.error?.errors?.[0]?.reason ?? j?.error?.status;
  if (res.status === 401) {
    await auth.onTokenRejected?.();
    return new PublishError('O YouTube recusou o acesso desta conta. Reconecte-a em Contas sociais.');
  }
  return new PublishError(REASONS[reason ?? ''] ?? `O YouTube recusou o envio (HTTP ${res.status}${reason ? `, ${reason}` : ''}).`);
}
