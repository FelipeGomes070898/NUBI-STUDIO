import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** FFmpeg: FFMPEG_PATH (se definido) ou o binário estático do pacote @ffmpeg-installer. */
export async function ffmpegPath(): Promise<string> {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const mod = await import('@ffmpeg-installer/ffmpeg');
  return (mod.default ?? (mod as unknown as { path: string })).path;
}

type FfmpegError = Error & { stderr: string };

function run(bin: string, args: string[], timeoutMs: number): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) {
        const e = new Error(`FFmpeg falhou: ${String(stderr || err.message).split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400)}`) as FfmpegError;
        e.stderr = String(stderr);
        reject(e);
      } else resolve({ stderr });
    });
  });
}

/** `ffmpeg -i arquivo` sem saída "falha" de propósito, mas imprime duração, trilhas e dimensões. */
async function probe(bin: string, file: string): Promise<string> {
  try {
    return (await run(bin, ['-hide_banner', '-i', file], 30_000)).stderr;
  } catch (e) {
    return (e as FfmpegError).stderr ?? '';
  }
}

export interface RenderResult {
  bytes: Buffer;
  width: number;
  height: number;
  /** Duração real do arquivo final. */
  seconds: number;
  /** Aviso não fatal (ex.: clipes mais curtos que o pedido, áudio descartado). */
  note?: string;
}

const dims = (log: string) => {
  const m = /Video:[^\n]*?(\d{2,5})x(\d{2,5})/.exec(log);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 0, height: 0 };
};
const duration = (log: string) => {
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

/**
 * Une os clipes na ordem e corta na duração exata pedida. Reencoda (H.264 + AAC, faststart) para o corte ser preciso e
 * o arquivo servir em todas as redes. Se a união direta falhar (clipes com parâmetros diferentes), refaz sem áudio.
 */
export async function renderFinal(o: { clips: Uint8Array[]; targetSeconds: number }): Promise<RenderResult> {
  if (o.clips.length === 0) throw new Error('Nenhum clipe para montar.');
  const bin = await ffmpegPath();
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-'));
  try {
    const files: string[] = [];
    for (let i = 0; i < o.clips.length; i++) {
      const f = path.join(dir, `clip${i}.mp4`);
      await writeFile(f, o.clips[i]!);
      files.push(f);
    }
    // cada clipe precisa ser um vídeo legível: um clipe quebrado não pode sumir em silêncio do resultado
    for (let i = 0; i < files.length; i++) {
      const info = await probe(bin, files[i]!);
      const d = duration(info);
      if (!/Video:/.test(info) || d <= 0) throw new Error(`O clipe ${i + 1} está corrompido ou não é um vídeo.`);
    }
    const out = path.join(dir, 'final.mp4');
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p'];
    const t = String(Math.max(1, o.targetSeconds));
    let note: string | undefined;

    await writeFile(path.join(dir, 'list.txt'), files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
    try {
      await run(bin, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'), '-t', t, ...enc, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], 240_000);
    } catch {
      const inputs = files.flatMap((f) => ['-i', f]);
      const chain = files.map((_, i) => `[${i}:v:0]`).join('') + `concat=n=${files.length}:v=1:a=0[v]`;
      await run(bin, ['-v', 'error', '-y', ...inputs, '-filter_complex', chain, '-map', '[v]', '-t', t, ...enc, '-an', '-movflags', '+faststart', out], 240_000);
      note = 'Os clipes não puderam ser unidos com áudio; o vídeo final saiu sem som.';
    }

    const info = await probe(bin, out);
    const bytes = await readFile(out);
    const seconds = Math.round(duration(info) * 10) / 10;
    const short = seconds > 0 && seconds < o.targetSeconds - 0.5;
    return {
      bytes,
      ...dims(info),
      seconds,
      note: [note, short ? `Os clipes geraram só ${seconds}s dos ${o.targetSeconds}s pedidos.` : null].filter(Boolean).join(' ') || undefined,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Reduz uma imagem (JPEG) até caber em `maxBytes` — o YouTube só aceita thumbnail de até 2 MB. Devolve a original se já couber. */
export async function fitImage(bytes: Uint8Array, maxBytes: number): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (bytes.length <= maxBytes && (isPng || isJpeg)) return { bytes, mime: isPng ? 'image/png' : 'image/jpeg' };
  const bin = await ffmpegPath();
  const dir = await mkdtemp(path.join(tmpdir(), 'img-'));
  try {
    await writeFile(path.join(dir, 'in'), bytes);
    for (const q of ['3', '6', '10', '16']) {
      const out = path.join(dir, `out${q}.jpg`);
      await run(bin, ['-v', 'error', '-y', '-i', path.join(dir, 'in'), '-q:v', q, '-frames:v', '1', out], 30_000);
      const b = await readFile(out);
      if (b.length <= maxBytes) return { bytes: new Uint8Array(b), mime: 'image/jpeg' };
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
