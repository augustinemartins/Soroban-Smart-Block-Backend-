import { Router, Request, Response } from 'express';
import { prismaRead, prismaWrite } from '../db';
import { asyncHandler } from '../middleware/asyncHandler';

interface SearchIndexEntry {
  contractAddress: string;
  contentType: string;
  content: string;
  metadata: unknown;
}

interface ContractSource {
  contractAddress: string;
  functionDetails: Array<{
    name: string;
    pseudoCode?: string;
    params?: string[];
    returns?: string[];
    selector: string;
    complexity?: string;
  }>;
  imports: unknown[];
  exports: unknown[];
  events: unknown[];
  errors: unknown[];
  storageVariables: unknown[];
}

export const searchRouter = Router();

// GET /search?q=<query> — full-text search across all contracts
// Supports faceted search with prefix notation:
//   - function:<name>
//   - import:<module>
//   - event:<name>
//   - storage:<key>
//   - error:<name>
searchRouter.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const { q, limit = 50, offset = 0 } = req.query;

    if (!q || typeof q !== 'string' || q.length < 2) {
      return res.status(400).json({ error: 'Query string q required (min 2 chars)' });
    }

    const parsedLimit = Math.min(Number(limit) || 50, 200);
    const parsedOffset = Math.max(Number(offset) || 0, 0);

    try {
      // Parse query facets
      const functionMatch = q.match(/function:(\w+)/i)?.[1];
      const importMatch = q.match(/import:(\w+)/i)?.[1];
      const eventMatch = q.match(/event:(\w+)/i)?.[1];
      const storageMatch = q.match(/storage:(\w+)/i)?.[1];
      const errorMatch = q.match(/error:(\w+)/i)?.[1];

      // Clean query for general search
      const cleanQuery = q
        .replace(/function:\w+/i, '')
        .replace(/import:\w+/i, '')
        .replace(/event:\w+/i, '')
        .replace(/storage:\w+/i, '')
        .replace(/error:\w+/i, '')
        .trim();

      const searchIndexEntries = await (
        prismaRead as unknown as {
          searchIndexEntry: { findMany: (args: unknown) => Promise<SearchIndexEntry[]> };
        }
      ).searchIndexEntry.findMany({
        where: {
          AND: [
            cleanQuery ? { content: { contains: cleanQuery, mode: 'insensitive' } } : undefined,
            functionMatch
              ? {
                  AND: [
                    { contentType: 'function' },
                    { content: { contains: functionMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            importMatch
              ? {
                  AND: [
                    { contentType: 'import' },
                    { content: { contains: importMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            eventMatch
              ? {
                  AND: [
                    { contentType: 'event' },
                    { content: { contains: eventMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            storageMatch
              ? {
                  AND: [
                    { contentType: 'storage' },
                    { content: { contains: storageMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
            errorMatch
              ? {
                  AND: [
                    { contentType: 'error' },
                    { content: { contains: errorMatch, mode: 'insensitive' } },
                  ],
                }
              : undefined,
          ].filter(Boolean),
        },
        select: { contractAddress: true, contentType: true, content: true, metadata: true },
        take: parsedLimit,
        skip: parsedOffset,
      });

      // Group by contract and facet
      const results: Record<
        string,
        { address: string; hits: Record<string, Array<{ content: string; metadata: unknown }>> }
      > = {};
      for (const entry of searchIndexEntries) {
        if (!results[entry.contractAddress]) {
          results[entry.contractAddress] = { address: entry.contractAddress, hits: {} };
        }
        if (!results[entry.contractAddress].hits[entry.contentType]) {
          results[entry.contractAddress].hits[entry.contentType] = [];
        }
        results[entry.contractAddress].hits[entry.contentType].push({
          content: entry.content,
          metadata: entry.metadata,
        });
      }

      return res.json({
        query: q,
        total: Object.keys(results).length,
        results: Object.values(results),
      });
    } catch (err: any) {
      return res.status(500).json({ error: 'Search failed', detail: String(err) });
    }
  }),
);

// GET /search/index — trigger re-indexing of all contracts
searchRouter.get('/index', async (req: Request, res: Response) => {
  try {
    // Fetch all contract sources and rebuild search index
    const sources = await (
      prismaRead as unknown as {
        contractSource: { findMany: (args: unknown) => Promise<ContractSource[]> };
      }
    ).contractSource.findMany({
      include: { functionDetails: true },
    });

    // Clear existing index
    await (
      prismaWrite as unknown as {
        searchIndexEntry: { deleteMany: (args: unknown) => Promise<{ count: number }> };
      }
    ).searchIndexEntry.deleteMany({});

    let indexed = 0;
    for (const source of sources) {
      // Index functions
      for (const fn of source.functionDetails || []) {
        await (
          prismaWrite as unknown as {
            searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
          }
        ).searchIndexEntry.create({
          data: {
            contractAddress: source.contractAddress,
            contentType: 'function',
            content: `${fn.name} ${fn.pseudoCode || ''} ${(fn.params || []).join(' ')} ${(fn.returns || []).join(' ')}`,
            metadata: { selector: fn.selector, complexity: fn.complexity },
          },
        });
        indexed++;
      }

      // Index imports
      const imports = (source.imports as Array<Record<string, unknown>>) || [];
      for (const imp of imports) {
        await (
          prismaWrite as unknown as {
            searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
          }
        ).searchIndexEntry.create({
          data: {
            contractAddress: source.contractAddress,
            contentType: 'import',
            content: `${imp.module} ${imp.name}`,
            metadata: { kind: imp.kind, host: imp.host },
          },
        });
        indexed++;
      }

      // Index exports
      const exports = (source.exports as Array<Record<string, unknown>>) || [];
      for (const exp of exports) {
        await (
          prismaWrite as unknown as {
            searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
          }
        ).searchIndexEntry.create({
          data: {
            contractAddress: source.contractAddress,
            contentType: 'export',
            content: exp.name,
            metadata: { kind: exp.kind, index: exp.index },
          },
        });
        indexed++;
      }

      // Index events
      const events = (source.events as unknown[]) || [];
      if (Array.isArray(events)) {
        for (const evt of events) {
          await (
            prismaWrite as unknown as {
              searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
            }
          ).searchIndexEntry.create({
            data: {
              contractAddress: source.contractAddress,
              contentType: 'event',
              content: JSON.stringify(evt),
              metadata: evt,
            },
          });
          indexed++;
        }
      }

      // Index errors
      const errors = (source.errors as unknown[]) || [];
      if (Array.isArray(errors)) {
        for (const err of errors) {
          await (
            prismaWrite as unknown as {
              searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
            }
          ).searchIndexEntry.create({
            data: {
              contractAddress: source.contractAddress,
              contentType: 'error',
              content: JSON.stringify(err),
              metadata: err,
            },
          });
          indexed++;
        }
      }

      // Index storage variables
      const storage = (source.storageVariables as unknown[]) || [];
      if (Array.isArray(storage)) {
        for (const stor of storage) {
          await (
            prismaWrite as unknown as {
              searchIndexEntry: { create: (args: unknown) => Promise<unknown> };
            }
          ).searchIndexEntry.create({
            data: {
              contractAddress: source.contractAddress,
              contentType: 'storage',
              content: JSON.stringify(stor),
              metadata: stor,
            },
          });
          indexed++;
        }
      }
    }

    return res.json({
      indexed,
      message: `Reindexed ${indexed} entries from ${sources.length} contracts`,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'Indexing failed', detail: String(err) });
  }
});
