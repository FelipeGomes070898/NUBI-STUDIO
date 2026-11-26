'use client';
import { upload } from '@vercel/blob/client';
import { useActionState, useState } from 'react';
import { saveCharacterAction, type CharacterState } from './actions';

const MAX = 3;

export function CharacterForm({ initial, blobReady }: { initial?: { id: string; name: string; description: string; referenceUrls: string[] }; blobReady: boolean }) {
  const [state, action, pending] = useActionState<CharacterState, FormData>(saveCharacterAction, {});
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [urls, setUrls] = useState<string[]>(initial?.referenceUrls ?? []);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setErr(null);
    setUploading(true);
    try {
      const next = [...urls];
      for (const f of Array.from(files)) {
        if (next.length >= MAX) break;
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) throw new Error('Use imagens PNG, JPG ou WebP.');
        if (f.size > 8 * 1024 * 1024) throw new Error('Cada imagem pode ter até 8 MB.');
        const b = await upload(`characters/${f.name.replace(/[^\w.\-]+/g, '_')}`, f, { access: 'public', handleUploadUrl: '/api/blob/upload', clientPayload: 'image', contentType: f.type });
        next.push(b.url);
      }
      setUrls(next);
    } catch (e) {
      setErr((e as Error).message || 'Falha no envio da imagem.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <form action={action} className="stack">
      {initial && <input type="hidden" name="entityId" value={initial.id} />}
      {urls.map((u) => <input key={u} type="hidden" name="referenceUrls" value={u} />)}
      {state.error && <div className="flash flashErr" role="alert">{state.error}</div>}
      <label>Nome do personagem<input name="name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="ex.: Luciano ZEEN" /></label>
      <label>Descrição fixa (aparência, roupa, estilo, jeito) — entra em TODAS as cenas e na thumbnail
        <textarea name="description" required minLength={10} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: menino de 8 anos, cabelo cacheado castanho, camiseta amarela com um raio no peito, tênis vermelho, sorriso aberto, estilo desenho 3D colorido" />
      </label>
      <div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 8 }}>Imagens de referência (até {MAX}; a primeira guia o vídeo e todas guiam a thumbnail)</div>
        <div className="row" style={{ alignItems: 'center' }}>
          {urls.map((u) => (
            <div key={u} className="noflex" style={{ position: 'relative' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={u} alt="Referência do personagem" style={{ width: 84, height: 84, objectFit: 'cover', borderRadius: 10, border: '1px solid var(--line)' }} />
              <button type="button" className="danger small" style={{ position: 'absolute', top: -8, right: -8, padding: '2px 7px' }} onClick={() => setUrls(urls.filter((x) => x !== u))} aria-label="Remover imagem">×</button>
            </div>
          ))}
          {urls.length < MAX && blobReady && (
            <label className="noflex" style={{ cursor: 'pointer' }}>
              <span className="btn secondary small">{uploading ? 'Enviando…' : '＋ Adicionar imagem'}</span>
              <input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={uploading} onChange={(e) => { void onFiles(e.target.files); e.target.value = ''; }} />
            </label>
          )}
        </div>
        {!blobReady && <small style={{ color: 'var(--warn)' }}>Envio de imagens indisponível: conecte o Vercel Blob ao projeto.</small>}
        {err && <div className="flash flashErr" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      </div>
      <div><button disabled={pending || uploading}>{pending ? 'Salvando…' : initial ? 'Salvar personagem' : 'Criar personagem'}</button></div>
    </form>
  );
}
