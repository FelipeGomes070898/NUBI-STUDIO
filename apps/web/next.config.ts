import type { NextConfig } from 'next';

// O FFmpeg (montagem do vídeo) é um binário carregado por caminho dinâmico: o Next não o enxerga sozinho.
// Incluímos o pacote da plataforma só nas funções que montam vídeo/imagem (Estúdio), para ele ir junto no deploy da Vercel
// sem inchar as demais (o binário tem ~68 MB e o limite por função é 250 MB).
const FFMPEG = ['../../node_modules/.pnpm/@ffmpeg-installer+*/node_modules/@ffmpeg-installer/**/*'];

const config: NextConfig = {
  transpilePackages: ['@social-manager/db'],
  serverExternalPackages: ['@prisma/client', '@ffmpeg-installer/ffmpeg'],
  outputFileTracingIncludes: {
    '/api/cron/studio': FFMPEG,
    '/studio': FFMPEG,
    '/studio/[id]': FFMPEG,
  },
};

export default config;
