// Copia o binário do FFmpeg (pacote @ffmpeg-installer) para um arquivo COMUM dentro do projeto: apps/web/.ffmpeg/ffmpeg.
// Motivo: o pnpm guarda o binário atrás de links simbólicos (node_modules/.pnpm/...), que o empacotador das funções da
// Vercel não consegue seguir (ENOENT). Um arquivo comum é incluído sem surpresas (ver outputFileTracingIncludes).
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const src = require('@ffmpeg-installer/ffmpeg').path;
mkdirSync('.ffmpeg', { recursive: true });
copyFileSync(src, '.ffmpeg/ffmpeg');
chmodSync('.ffmpeg/ffmpeg', 0o755);
console.log(`[prepare-ffmpeg] ${src} -> .ffmpeg/ffmpeg (${Math.round(statSync('.ffmpeg/ffmpeg').size / 1e6)} MB)`);
