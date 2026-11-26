import { z } from 'zod';

// ── Duração → cenas ───────────────────────────────────────

/** Durações de clipe aceitas pelo modelo de vídeo (Veo 3.x: 4, 6 ou 8 s; Veo 3: só 8). Configurável: VEO_ALLOWED_SECONDS="8". */
export function allowedClipSeconds(): number[] {
  const parsed = (process.env.VEO_ALLOWED_SECONDS ?? '4,6,8').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0 && n <= 30);
  return parsed.length ? [...new Set(parsed)].sort((a, b) => a - b) : [4, 6, 8];
}

export const maxStudioSeconds = () => (Number(process.env.STUDIO_MAX_SECONDS) > 0 ? Number(process.env.STUDIO_MAX_SECONDS) : 120);
export const MAX_SCENES = 20;

/**
 * Quebra a duração pedida em clipes: tantos clipes cheios quanto couberem e, no resto, o menor clipe permitido que cubra.
 * A soma pode passar da duração pedida (o vídeo final é cortado no tamanho exato). Ex. (4,6,8): 10 → [8,4]; 30 → [8,8,8,6].
 */
export function planDurations(targetSeconds: number, allowed: number[] = allowedClipSeconds()): number[] {
  const opts = [...allowed].sort((a, b) => a - b);
  const max = opts[opts.length - 1]!;
  const target = Math.max(1, Math.ceil(targetSeconds));
  const full = Math.floor(target / max);
  const rest = target - full * max;
  const out = Array<number>(full).fill(max);
  if (rest > 0) out.push(opts.find((o) => o >= rest) ?? max);
  return out.length ? out : [opts[0]!];
}

// ── Personagem ────────────────────────────────────────────

export interface CharacterInfo {
  name: string;
  description: string;
  referenceUrls: string[];
}

/** Bloco que vai igual em TODAS as cenas e na thumbnail: é o que mantém o personagem fixo. */
export function characterBlock(c: CharacterInfo | null): string {
  if (!c) return '';
  return `FIXED CHARACTER "${c.name}" — must appear in every scene with exactly this look, never changing: ${c.description.replace(/\s+/g, ' ').trim()}`;
}

// ── Prompts de texto (Claude etc.) ────────────────────────

const JSON_ONLY = 'Responda SOMENTE com JSON válido, sem texto antes ou depois e sem cercas de código.';

export function planPrompt(o: { idea: string; character: CharacterInfo | null; durations: number[]; aspect: string }) {
  const total = o.durations.reduce((a, b) => a + b, 0);
  const vertical = o.aspect === '9:16';
  return {
    system:
      'Você é roteirista e diretor de vídeos curtos para redes sociais. Você escreve prompts de cena para um modelo de vídeo por IA (Veo). ' +
      'Cada prompt de cena é em INGLÊS, concreto e visual: ambiente, ação, câmera, luz, clima. Sem legendas nem texto na tela. ' +
      'As cenas são consecutivas e contam uma história contínua. ' + JSON_ONLY,
    prompt:
      `Ideia do vídeo: ${o.idea}\n` +
      `Formato: ${vertical ? 'vertical 9:16' : 'horizontal 16:9'}. Duração total ≈ ${total}s em ${o.durations.length} cena(s) de ${o.durations.join('s, ')}s, nesta ordem.\n` +
      (o.character ? `Personagem fixo (NÃO reescreva a aparência dele nas cenas, só diga o que ele faz): ${o.character.name}. ${o.character.description}\n` : '') +
      `Devolva: {"scenes":[{"visual":"..."}]} com EXATAMENTE ${o.durations.length} item(ns). Cada "visual" descreve só o que acontece naquela cena (${o.durations[0]}-${Math.max(...o.durations)}s) e continua a anterior.`,
  };
}

export function copyPrompt(o: { idea: string; character: CharacterInfo | null; scenes: string[]; platforms?: string }) {
  return {
    system: 'Você é especialista em títulos, descrições e hashtags para vídeos curtos (YouTube, TikTok, Instagram, Facebook), em português do Brasil. ' + JSON_ONLY,
    prompt:
      `Ideia do vídeo: ${o.idea}\n` +
      (o.character ? `Personagem: ${o.character.name} — ${o.character.description}\n` : '') +
      `Resumo das cenas: ${o.scenes.map((s, i) => `${i + 1}) ${s}`).join(' ')}\n` +
      'Devolva: {"titles":["3 a 5 opções, até 70 caracteres, chamativas e honestas"],"description":"descrição curta de 2 a 4 linhas","tags":["até 15 palavras-chave sem #"],"hashtags":["até 8, começando com #"]}',
  };
}

export function thumbPrompt(o: { title: string; character: CharacterInfo | null; scene: string; aspect: string }): string {
  return [
    `Create an eye-catching video thumbnail, ${o.aspect === '9:16' ? 'vertical 9:16' : 'horizontal 16:9'} composition, high contrast, vivid colors, clear focal point, no watermark.`,
    characterBlock(o.character),
    `Scene inspiration: ${o.scene}`,
    `The thumbnail is for a video titled: "${o.title}". Leave clean space for the title; do not write any other text.`,
  ].filter(Boolean).join('\n');
}

/** Prompt final de cada cena: personagem fixo + estilo contínuo + o que acontece na cena. */
export function sceneVideoPrompt(o: { visual: string; character: CharacterInfo | null; index: number; total: number }): string {
  return [
    characterBlock(o.character),
    `Scene ${o.index + 1} of ${o.total}${o.index > 0 ? ' — continues directly from the previous scene, same character, same place and style unless the action says otherwise' : ''}.`,
    o.visual.trim(),
    'No subtitles, no captions, no on-screen text, no watermark.',
  ].filter(Boolean).join('\n');
}

export const NEGATIVE_PROMPT = 'subtitles, captions, on-screen text, watermark, logo, distorted face, extra fingers';

// ── Leitura das respostas ─────────────────────────────────

/** Extrai o primeiro objeto JSON de uma resposta (aceita cerca ```json e texto em volta). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('sem JSON');
  // procura o fechamento balanceado (respeita strings)
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(candidate.slice(start, i + 1));
  }
  throw new Error('JSON incompleto');
}

const PlanSchema = z.object({ scenes: z.array(z.object({ visual: z.string().min(3) })).min(1) });

/** Garante uma cena por clipe: sobra é descartada; falta é erro (melhor refazer do que inventar cena). */
export function parsePlan(text: string, expected: number): string[] {
  const parsed = PlanSchema.parse(extractJson(text));
  if (parsed.scenes.length < expected) throw new Error(`o roteiro veio com ${parsed.scenes.length} cena(s), esperado ${expected}`);
  return parsed.scenes.slice(0, expected).map((s) => s.visual.trim().slice(0, 1500));
}

const CopySchema = z.object({
  titles: z.array(z.string()).min(1),
  description: z.string().default(''),
  tags: z.array(z.string()).default([]),
  hashtags: z.array(z.string()).default([]),
});

export interface CopyResult { titles: string[]; description: string; tags: string[]; hashtags: string[] }

/** Limpa o texto para as regras das redes: título ≤100 e sem < >; tags sem #, ≤500 caracteres no total; hashtags com # e sem espaço. */
export function parseCopy(text: string): CopyResult {
  const c = CopySchema.parse(extractJson(text));
  const noAngle = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
  const titles = [...new Set(c.titles.map((t) => noAngle(t).slice(0, 100)).filter(Boolean))].slice(0, 5);
  if (!titles.length) throw new Error('sem títulos');
  const tags: string[] = [];
  let len = 0;
  for (const t of c.tags.map((x) => noAngle(x).replace(/^#+/, '')).filter(Boolean)) {
    if (tags.includes(t) || len + t.length + 1 > 480) continue;
    tags.push(t); len += t.length + 1;
  }
  const hashtags = [...new Set(c.hashtags.map((h) => '#' + noAngle(h).replace(/^#+/, '').replace(/\s+/g, '')).filter((h) => h.length > 1))].slice(0, 8);
  return { titles, description: noAngle(c.description).slice(0, 1500), tags: tags.slice(0, 15), hashtags };
}

/** Legenda pronta para publicar: descrição + hashtags. */
export const captionWithHashtags = (description: string, hashtags: string[]) => [description.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n');
