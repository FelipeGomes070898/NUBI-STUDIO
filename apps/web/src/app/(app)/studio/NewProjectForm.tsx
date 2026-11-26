'use client';
import { useActionState, useMemo, useState } from 'react';
import { allowedClipSeconds, planDurations } from '@/server/studio/prompts';
import { createProjectAction, type StudioState } from './actions';

export interface FormGroup { id: string; name: string; format: string; characterId: string | null }
export interface FormCharacter { id: string; name: string }

const PRESETS = [10, 20, 30, 45, 60];

export function NewProjectForm({ groups, characters, video, clipSeconds, maxSeconds }: {
  groups: FormGroup[]; characters: FormCharacter[]; video: { model: string; perSecond: number } | null; clipSeconds: number[]; maxSeconds: number;
}) {
  const [state, action, pending] = useActionState<StudioState, FormData>(createProjectAction, {});
  const [prompt, setPrompt] = useState('');
  const [groupId, setGroupId] = useState('');
  const [character, setCharacter] = useState('');
  const [seconds, setSeconds] = useState('10');
  const [aspect, setAspect] = useState('');

  const group = groups.find((g) => g.id === groupId);
  const groupChar = characters.find((c) => c.id === group?.characterId);
  const n = Number(seconds);
  const valid = Number.isFinite(n) && n >= 3 && n <= maxSeconds;
  const durations = useMemo(() => (valid ? planDurations(n, clipSeconds.length ? clipSeconds : allowedClipSeconds()) : []), [n, valid, clipSeconds]);
  const total = durations.reduce((a, b) => a + b, 0);
  const cost = video ? total * video.perSecond : null;
  const effectiveAspect = aspect || (group?.format === 'HORIZONTAL_16_9' ? '16:9' : '9:16');

  return (
    <form action={action} className="stack">
      {state.error && <div className="flash flashErr" role="alert">{state.error}</div>}
      <label>Ideia do vídeo (o prompt)
        <textarea name="prompt" required minLength={5} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Ex.: O Luciano encontra um foguete abandonado no quintal e decola até a Lua, desviando de asteroides." style={{ minHeight: 130 }} />
      </label>
      <div className="row">
        <label>Grupo (define o personagem fixo e o formato)
          <select name="groupId" value={groupId} onChange={(e) => { setGroupId(e.target.value); setCharacter(''); }}>
            <option value="">— sem grupo —</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label>Personagem
          <select name="characterId" value={character} onChange={(e) => setCharacter(e.target.value)}>
            <option value="">{groupChar ? `Fixo do grupo: ${groupChar.name}` : group ? 'Grupo sem personagem fixo' : 'Nenhum (escolha um grupo ou um personagem)'}</option>
            <option value="none">Sem personagem</option>
            {characters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Formato
          <select name="aspect" value={aspect} onChange={(e) => setAspect(e.target.value)}>
            <option value="">Automático ({effectiveAspect === '9:16' ? 'vertical 9:16' : 'horizontal 16:9'})</option>
            <option value="9:16">Vertical 9:16</option>
            <option value="16:9">Horizontal 16:9</option>
          </select>
        </label>
      </div>
      <div className="row">
        <label>Duração (segundos)
          <input name="seconds" type="number" min={3} max={maxSeconds} value={seconds} onChange={(e) => setSeconds(e.target.value)} required />
        </label>
        <div className="noflex" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          {PRESETS.filter((p) => p <= maxSeconds).map((p) => <button type="button" key={p} className={Number(seconds) === p ? 'small' : 'secondary small'} onClick={() => setSeconds(String(p))}>{p}s</button>)}
        </div>
      </div>

      <div className="card" style={{ background: 'var(--panel2)' }}>
        {!valid ? <small>A duração deve ficar entre 3 e {maxSeconds} segundos.</small> : (
          <small>
            <strong style={{ color: 'var(--text)' }}>{durations.length} cena(s)</strong> de {durations.join('s + ')}s = {total}s gerados; o vídeo final é cortado em exatos <strong style={{ color: 'var(--text)' }}>{n}s</strong>.{' '}
            {video && cost !== null
              ? <>Custo máximo do vídeo: <strong style={{ color: 'var(--text)' }}>US$ {cost.toFixed(2)}</strong> ({video.model} a US$ {video.perSecond}/s), mais centavos de roteiro, textos e thumbnail.</>
              : <span style={{ color: 'var(--warn)' }}>Cadastre um modelo de vídeo (Google Gemini/Veo) com preço em Central de IA para ver e controlar o custo.</span>}
          </small>
        )}
      </div>

      <div><button disabled={pending || !valid}>{pending ? 'Criando…' : 'Gerar vídeo'}</button> <small>O saldo é verificado antes de começar; o gasto só acontece cena a cena.</small></div>
    </form>
  );
}
