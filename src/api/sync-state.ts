/**
 * GET /api/v1/sync-state
 *
 * Returns the DB's max synced ledger vs the live network tip so the frontend
 * can display a "Syncing… (99.9%)" banner when the indexer lags behind.
 */

import { Router, Request, Response } from 'express';
import { prismaRead as prisma } from '../db';
import { getLatestLedger } from '../indexer/rpc';

/**
 * @swagger
 * tags:
 *   name: Sync State
 *   description: Indexer synchronisation status
 */

export const syncStateRouter = Router();

export async function getSyncState(): Promise<{
  dbLedger: number;
  networkLedger: number;
  syncPercent: number;
  isSynced: boolean;
}> {
  const [agg, networkLedger] = await Promise.all([
    prisma.ledger.aggregate({ _max: { sequence: true } }),
    getLatestLedger(),
  ]);

  const dbLedger = agg._max.sequence ?? 0;
  const syncPercent = networkLedger > 0 ? Math.min(100, (dbLedger / networkLedger) * 100) : 100;

  return {
    dbLedger,
    networkLedger,
    syncPercent: Math.round(syncPercent * 10) / 10,
    isSynced: dbLedger >= networkLedger,
  };
}

/**
 * @swagger
 * /api/v1/sync-state:
 *   get:
 *     summary: Get indexer synchronisation status
 *     description: Returns the highest ledger stored in the database compared to the live network tip, with a sync percentage.
 *     tags: [Sync State]
 *     responses:
 *       200:
 *         description: Current sync status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 dbLedger:
 *                   type: integer
 *                   description: Highest ledger sequence stored in the database
 *                   example: 3168070
 *                 networkLedger:
 *                   type: integer
 *                   description: Current ledger sequence on the live Stellar network
 *                   example: 3168075
 *                 syncPercent:
 *                   type: number
 *                   description: Percentage of ledgers indexed (0–100)
 *                   example: 99.9
 *                 isSynced:
 *                   type: boolean
 *                   description: True when dbLedger >= networkLedger
 *                   example: false
 *       500:
 *         description: Failed to query DB or RPC
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
syncStateRouter.get('/', async (_req: Request, res: Response) => {
  try {
    res.json(await getSyncState());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
