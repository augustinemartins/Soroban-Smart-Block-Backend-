import { PrismaClient } from '@prisma/client';
import { config } from './config';

const logLevel = config.nodeEnv === 'development'
  ? (['error', 'warn'] as const)
  : (['error'] as const);

/** Primary write client — uses the active profile's database cluster. */
export const prismaWrite = new PrismaClient({
  log: logLevel,
  datasources: { db: { url: config.databaseUrl } },
});

/** Read-replica client — uses the active profile's replica (falls back to primary). */
export const prismaRead = new PrismaClient({
  log: logLevel,
  datasources: { db: { url: config.readReplicaUrl } },
});

/** @deprecated Use prismaWrite or prismaRead explicitly. */
export const prisma = prismaWrite;
