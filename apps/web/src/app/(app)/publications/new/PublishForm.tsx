'use client';
import { upload } from '@vercel/blob/client';
import { useActionState, useMemo, useState } from 'react';
import { LocalTime } from '@/components/LocalTime';
import { PLATFORM_ICON, PLATFORM_LABEL } from '@/lib/labels';
import { publishAction, registerMediaAction, type PublishState } from '../actions';

export interface FormAccount {
  id: string;
  platform: 'FACEBOOK' | 'TIKTOK' | 'YOUTUBE' | 'INSTAGRAM';
  name: string;
  usable: boolean;
  reason?: string;
  lastPublished: string | null;
  lastScheduled: string | null;
}
export interface FormGroup { id: string; name: string; format: string; formatLabel: string; accountIds: string[] }

interface Uploaded { id: string; name: string; sizeMb: number; format: string; width: number; height: number; duration: number }

const MB = 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

/** Lê largura/altura/duração no próprio navegador (sem enviar nada). */
function readMeta(file: File): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (r: { width: number; height: number; duration: number }) => { URL.revokeObjectURL(url); resolve(r); };
    v.preload = 'metadata';
    v.onloadedmetadata = () => done({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => done({ width: 0, height: 0, duration: 0 });
    v.src = url;
  });
}

const orientation = (w: number, h: number) => (!w || !h ? 'FLEXIBLE' : w === h ? 'SQUARE_1_1' : h > w ? 'VERTICAL_9_16' : 'HORIZONTAL_16_9');

export function PublishForm({ accounts, groups, blobReady, maxMb, gapMinutes, defaultTz }: {
  accounts: FormAccount[]; groups: FormGroup[]; blobReady: boolean; maxMb: number; gapMinutes: number; defaultTz: string;
}) {
  const [state, formAction, pending] = useActionState<PublishState, FormData>(publishAction, {});
  const [media, setMedia] = useState<Uploaded | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [selGroups, setSelGroups] = useState<Set<string>>(new Set());
  const [selAccounts, setSelAccounts] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<'NOW' | 'SCHEDULE'>('NOW');
  // Campos controlados: o React 19 limpa campos não controlados depois de cada ação, e o usuário perderia o texto ao errar.
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState('PUBLIC');
  const [when, setWhen] = useState('');
  const [ignoreGap, setIgnoreGap] = useState(false);
  const tz = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || defaultTz; } catch { return defaultTz; } }, [defaultTz]);

  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const inAnyGroup = useMemo(() => new Set(groups.flatMap((g) => g.accountIds)), [groups]);

  function toggleGroup(g: FormGroup) {
    const nextGroups = new Set(selGroups);
    const nextAcc = new Set(selAccounts);
    if (nextGroups.has(g.id)) {
      nextGroups.delete(g.id);
      const stillCovered = new Set(groups.filter((x) => nextGroups.has(x.id)).flatMap((x) => x.accountIds));
      for (const id of g.accountIds) if (!stillCovered.has(id)) nextAcc.delete(id);
    } else {
      nextGroups.add(g.id);
      for (const id of g.accountIds) if (byId.get(id)?.usable) nextAcc.add(id);
    }
    setSelGroups(nextGroups);
    setSelAccounts(nextAcc);
  }
  function toggleAccount(id: string) {
    const n = new Set(selAccounts);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelAccounts(n);
  }

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploadError(null);
    setMedia(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const mime = file.type || MIME_BY_EXT[ext] || '';
    if (!Object.values(MIME_BY_EXT).includes(mime)) return setUploadError('Formato não aceito. Use MP4, MOV ou WebM.');
    if (file.size > maxMb * MB) return setUploadError(`O vídeo passa do limite de ${maxMb} MB.`);
    setUploading(true);
    setProgress(0);
    try {
      const meta = await readMeta(file);
      const blob = await upload(`videos/${file.name.replace(/[^\w.\-]+/g, '_')}`, file, {
        access: 'public',
        handleUploadUrl: '/api/blob/upload',
        contentType: mime,
        multipart: file.size > 100 * MB,
        onUploadProgress: (p) => setProgress(Math.round(p.percentage)),
      });
      const r = await registerMediaAction({ url: blob.url, name: file.name, sizeBytes: file.size, mimeType: mime, width: meta.width, height: meta.height, durationSec: meta.duration });
      if (!r.id) throw new Error(r.error ?? 'Não foi possível registrar o vídeo.');
      setMedia({ id: r.id, name: file.name, sizeMb: Math.round((file.size / MB) * 10) / 10, format: r.format ?? orientation(meta.width, meta.height), width: meta.width, height: meta.height, duration: meta.duration });
    } catch (e) {
      setUploadError((e as Error).message || 'Falha no envio do vídeo.');
    } finally {
      setUploading(false);
    }
  }

  const mismatches = media
    ? groups.filter((g) => selGroups.has(g.id) && g.format !== 'FLEXIBLE' && media.format !== 'FLEXIBLE' && g.format !== media.format)
    : [];
  const minWhen = useMemo(() => { const d = new Date(Date.now() + 5 * 60_000 - new Date().getTimezoneOffset() * 60_000); return d.toISOString().slice(0, 16); }, []);
  const platforms = (['YOUTUBE', 'FACEBOOK', 'TIKTOK', 'INSTAGRAM'] as const).filter((p) => accounts.some((a) => a.platform === p));
  const canSubmit = !!media && selAccounts.size > 0 && !pending && !uploading;

  return (
    <form action={formAction} className="stack">
      <input type="hidden" name="mediaId" value={media?.id ?? ''} />
      <input type="hidden" name="timezone" value={tz} />
      {[...selGroups].map((id) => <input key={id} type="hidden" name="groupIds" value={id} />)}
      {[...selAccounts].map((id) => <input key={id} type="hidden" name="accountIds" value={id} />)}

      {state.error && <div className="flash flashErr" role="alert">{state.error}</div>}

      <section className="card stack">
        <h3>1. Vídeo</h3>
        {!blobReady ? (
          <div className="flash flashErr">O armazenamento de vídeo ainda não está configurado (falta conectar o Vercel Blob ao projeto e fazer um novo deploy).</div>
        ) : (
          <>
            <label>Arquivo (MP4, MOV ou WebM, até {maxMb} MB)
              <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" disabled={uploading} onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            {uploading && <div><div className="bar"><i style={{ width: `${progress}%` }} /></div><small>Enviando… {progress}% (não feche a página)</small></div>}
            {uploadError && <div className="flash flashErr" role="alert">{uploadError}</div>}
            {media && (
              <div className="flash flashOk">
                ✓ <strong>{media.name}</strong> · {media.sizeMb} MB{media.width ? ` · ${media.width}×${media.height}` : ''}{media.duration ? ` · ${Math.round(media.duration)}s` : ''} · {media.format === 'VERTICAL_9_16' ? 'vertical' : media.format === 'HORIZONTAL_16_9' ? 'horizontal' : media.format === 'SQUARE_1_1' ? 'quadrado' : 'formato não detectado'}
              </div>
            )}
          </>
        )}
      </section>

      <section className="card stack">
        <h3>2. Onde publicar</h3>
        {groups.length > 0 && (
          <div>
            <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>Grupos (marcar um grupo seleciona as contas conectadas dele)</div>
            <div className="checks">
              {groups.map((g) => (
                <label className="inline" key={g.id}>
                  <input type="checkbox" checked={selGroups.has(g.id)} onChange={() => toggleGroup(g)} />
                  <span>{g.name} <small>· {g.formatLabel} · {g.accountIds.length} conta(s)</small></span>
                </label>
              ))}
            </div>
          </div>
        )}
        {mismatches.length > 0 && (
          <div className="flash" style={{ background: '#2f2511', border: '1px solid #5a4416', color: '#f5d48a' }}>
            Atenção: o vídeo é {media!.format === 'VERTICAL_9_16' ? 'vertical' : media!.format === 'HORIZONTAL_16_9' ? 'horizontal' : 'quadrado'}, mas {mismatches.map((g) => `"${g.name}" é ${g.formatLabel}`).join('; ')}. Dá para publicar assim, mas pode ficar com bordas ou cortes.
          </div>
        )}
        {accounts.length === 0 && <div className="empty">Nenhuma conta cadastrada. Conecte contas em <a href="/accounts">Contas sociais</a>.</div>}
        {platforms.map((p) => (
          <div key={p}>
            <div className="dim" style={{ fontSize: 12, margin: '6px 0 8px' }}>{PLATFORM_ICON[p]} {PLATFORM_LABEL[p]}</div>
            <div className="checks">
              {accounts.filter((a) => a.platform === p).map((a) => (
                <label className="inline" key={a.id} style={a.usable ? undefined : { opacity: 0.55 }}>
                  <input type="checkbox" disabled={!a.usable} checked={selAccounts.has(a.id)} onChange={() => toggleAccount(a.id)} />
                  <span>
                    {a.name} {!inAnyGroup.has(a.id) && <small>(sem grupo)</small>}
                    {a.usable ? (
                      <small style={{ display: 'block' }}>
                        último post: {a.lastPublished ? <LocalTime iso={a.lastPublished} /> : 'nenhum'} · agendado até: {a.lastScheduled ? <LocalTime iso={a.lastScheduled} /> : 'nada'}
                      </small>
                    ) : <small style={{ display: 'block', color: 'var(--warn)' }}>{a.reason}</small>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <small>{selAccounts.size} conta(s) selecionada(s)</small>
      </section>

      <section className="card stack">
        <h3>3. Texto</h3>
        <label>Título (obrigatório no YouTube; também entra na legenda das outras redes)
          <input name="title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>Legenda / descrição
          <textarea name="body" maxLength={2000} placeholder="Texto e #hashtags" value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <label>Visibilidade
          <select name="visibility" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="PUBLIC">Público</option>
            <option value="PRIVATE">Privado (YouTube privado, TikTok só eu, Facebook não publicado)</option>
          </select>
        </label>
      </section>

      <section className="card stack">
        <h3>4. Quando</h3>
        <div className="row">
          <label className="inline noflex"><input type="radio" name="mode" value="NOW" checked={mode === 'NOW'} onChange={() => setMode('NOW')} /> Publicar agora</label>
          <label className="inline noflex"><input type="radio" name="mode" value="SCHEDULE" checked={mode === 'SCHEDULE'} onChange={() => setMode('SCHEDULE')} /> Agendar</label>
        </div>
        {mode === 'SCHEDULE' && (
          <label>Data e hora (fuso do seu navegador: {tz})
            <input type="datetime-local" name="when" min={minWhen} required value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
        )}
        <label className="inline">
          <input type="checkbox" name="ignoreGap" checked={ignoreGap} onChange={(e) => setIgnoreGap(e.target.checked)} /> Ignorar o intervalo mínimo ({gapMinutes} min) entre publicações da mesma conta
        </label>
        <small>Para não repetir horário, o sistema recusa marcar uma conta a menos de {gapMinutes} minutos de outra publicação dela (já agendada ou publicada). O último post e o último agendamento de cada conta aparecem na lista acima.</small>
      </section>

      <div>
        <button disabled={!canSubmit}>{pending ? 'Enviando…' : mode === 'NOW' ? 'Publicar agora' : 'Agendar publicação'}</button>
        {!media && <small> Envie o vídeo primeiro.</small>}
        {media && selAccounts.size === 0 && <small> Escolha ao menos uma conta.</small>}
      </div>
    </form>
  );
}
