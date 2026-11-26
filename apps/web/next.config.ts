import type { NextConfig } from 'next';

// O FFmpeg (montagem do vídeo) é um binário carregado por caminho: o Next não o enxerga sozinho.
// O build copia o binário para um arquivo comum (.ffmpeg/ffmpeg, ver scripts/prepare-ffmpeg.mjs: o empacotador da Vercel não
// segue os links do pnpm) e o incluímos SÓ nas funções que montam vídeo/imagem (~68 MB; o limite por função é 250 MB).
const FFMPEG = ['./.ffmpeg/ffmpeg'];

const config: NextConfig = {
  transpilePackages: ['@social-manager/db'],
  serverExternalPackages: ['@prisma/client'],
  outputFileTracingIncludes: {
    '/api/cron/studio': FFMPEG,
    '/studio': FFMPEG,
    '/studio/[id]': FFMPEG,
  },
};

export default config;
