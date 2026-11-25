import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@social-manager/db'],
  serverExternalPackages: ['@prisma/client'],
};

export default config;
