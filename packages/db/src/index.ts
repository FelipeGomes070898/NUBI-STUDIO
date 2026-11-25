import { PrismaClient } from '@prisma/client';

export * from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __prisma?: PrismaClient };

/** Singleton para evitar múltiplas conexões durante o hot reload do Next. */
export const prisma: PrismaClient = globalForPrisma.__prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.__prisma = prisma;
