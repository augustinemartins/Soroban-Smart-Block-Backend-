import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { prismaRead } from '../db';
import {
  buildContractDependencyGraph,
  generateDependencyGraphSVG,
} from '../indexer/dependencyGraphCompiler';

/**
 * @swagger
 * tags:
 *   name: Graph
 *   description: Contract dependency visualization and analysis
 */

export const graphRouter = Router();

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of edge rows fetched per BFS frontier batch.
 * Keeps individual Prisma queries small even with large frontiers.
 */
const BATCH_SIZE = 500;

// ── Traversal option defaults ────────────────────────────────────────────────

/** Maximum hop depth explored from the seed address. */
const DEFAULT_MAX_DEPTH = 10;

/** Maximum number of unique contract addresses visited before truncating. */
const DEFAULT_MAX_NODES = 5_000;

/** Wall-clock budget in milliseconds for the full BFS traversal. */
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Types ────────────────────────────────────────────────────────────────────

interface TraversalOpts {
  maxDepth: number;
  maxNodes: number;
  timeoutMs: number;
}

interface GraphResponse {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
  truncated: boolean;
  meta: {
    visitedCount: number;
    edgeCount: number;
    depth: number;
    durationMs: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseOpts(query: Record<string, unknown>): TraversalOpts {
  const clamp = (val: unknown, def: number, min: number, max: number): number => {
    const n = Number(val);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def;
  };
  return {
    maxDepth: clamp(query.maxDepth, DEFAULT_MAX_DEPTH, 1, 50),
    maxNodes: clamp(query.maxNodes, DEFAULT_MAX_NODES, 1, 50_000),
    timeoutMs: clamp(query.timeoutMs, DEFAULT_TIMEOUT_MS, 100, 30_000),
  };
}

// ── Core BFS engines ─────────────────────────────────────────────────────────

/**
 * Paginated upstream BFS.
 *
 * For each depth level, queries:
 *   WHERE targetAddress IN (frontier) AND isActive = true
 *
 * "Upstream" means: who calls / depends on `address`?
 */
async function upstreamBfs(address: string, opts: TraversalOpts): Promise<GraphResponse> {
  const startMs = Date.now();
  const visited = new Set<string>([address]);
  const edges: Array<{ from: string; to: string }> = [];
  let frontier = new Set<string>([address]);
  let truncated = false;
  let reachedDepth = 0;

  for (let depth = 1; depth <= opts.maxDepth; depth++) {
    if (frontier.size === 0) break;
    if (Date.now() - startMs >= opts.timeoutMs) {
      truncated = true;
      break;
    }

    const nextFrontier = new Set<string>();
    const frontierArr = [...frontier];

    // Paginate through all edges pointing INTO the current frontier
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      if (Date.now() - startMs >= opts.timeoutMs) {
        truncated = true;
        break;
      }

      const rows = await prismaRead.contractDependency.findMany({
        where: { targetAddress: { in: frontierArr }, isActive: true },
        select: { id: true, sourceAddress: true, targetAddress: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const row of rows) {
        edges.push({ from: row.sourceAddress, to: row.targetAddress });
        if (!visited.has(row.sourceAddress)) {
          visited.add(row.sourceAddress);
          nextFrontier.add(row.sourceAddress);
        }
        if (visited.size >= opts.maxNodes) {
          truncated = true;
          break;
        }
      }

      if (truncated || rows.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        cursor = rows[rows.length - 1].id;
      }
    }

    if (nextFrontier.size > 0) {
      reachedDepth = depth;
    }
    frontier = nextFrontier;

    if (truncated) break;
  }

  return {
    nodes: [...visited],
    edges,
    truncated,
    meta: {
      visitedCount: visited.size,
      edgeCount: edges.length,
      depth: reachedDepth,
      durationMs: Date.now() - startMs,
    },
  };
}

/**
 * Paginated downstream BFS.
 *
 * For each depth level, queries:
 *   WHERE sourceAddress IN (frontier) AND isActive = true
 *
 * "Downstream" means: what does `address` call / depend on?
 */
async function downstreamBfs(address: string, opts: TraversalOpts): Promise<GraphResponse> {
  const startMs = Date.now();
  const visited = new Set<string>([address]);
  const edges: Array<{ from: string; to: string }> = [];
  let frontier = new Set<string>([address]);
  let truncated = false;
  let reachedDepth = 0;

  for (let depth = 1; depth <= opts.maxDepth; depth++) {
    if (frontier.size === 0) break;
    if (Date.now() - startMs >= opts.timeoutMs) {
      truncated = true;
      break;
    }

    const nextFrontier = new Set<string>();
    const frontierArr = [...frontier];

    // Paginate through all edges coming OUT OF the current frontier
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      if (Date.now() - startMs >= opts.timeoutMs) {
        truncated = true;
        break;
      }

      const rows = await prismaRead.contractDependency.findMany({
        where: { sourceAddress: { in: frontierArr }, isActive: true },
        select: { id: true, sourceAddress: true, targetAddress: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      for (const row of rows) {
        edges.push({ from: row.sourceAddress, to: row.targetAddress });
        if (!visited.has(row.targetAddress)) {
          visited.add(row.targetAddress);
          nextFrontier.add(row.targetAddress);
        }
        if (visited.size >= opts.maxNodes) {
          truncated = true;
          break;
        }
      }

      if (truncated || rows.length < BATCH_SIZE) {
        hasMore = false;
      } else {
        cursor = rows[rows.length - 1].id;
      }
    }

    if (nextFrontier.size > 0) {
      reachedDepth = depth;
    }
    frontier = nextFrontier;

    if (truncated) break;
  }

  return {
    nodes: [...visited],
    edges,
    truncated,
    meta: {
      visitedCount: visited.size,
      edgeCount: edges.length,
      depth: reachedDepth,
      durationMs: Date.now() - startMs,
    },
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * @swagger
 * /api/v1/graph/dependencies:
 *   get:
 *     summary: Get contract dependency graph as JSON with hierarchy
 *     tags: [Graph]
 *     responses:
 *       200:
 *         description: Contract dependency graph with parent-child relationships
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 nodes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       address: { type: string }
 *                       name: { type: string }
 *                       children: { type: array, items: { type: string } }
 *                       callCount: { type: integer }
 *                       depth: { type: integer }
 *                 edges:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       from: { type: string }
 *                       to: { type: string }
 *                       weight: { type: integer }
 *                 metadata:
 *                   type: object
 *                   properties:
 *                     totalNodes: { type: integer }
 *                     totalEdges: { type: integer }
 *                     maxDepth: { type: integer }
 *                     generatedAt: { type: string, format: date-time }
 */
graphRouter.get(
  '/dependencies',
  asyncHandler(async (_req: Request, res: Response) => {
    const graph = await buildContractDependencyGraph();
    res.json(graph);
  }),
);

/**
 * @swagger
 * /api/v1/graph/dependencies/svg:
 *   get:
 *     summary: Get contract dependency graph as SVG visualization
 *     tags: [Graph]
 *     description: Hierarchical layout with edge weights and depth-based coloring
 *     responses:
 *       200:
 *         description: SVG dependency graph
 *         content:
 *           image/svg+xml:
 *             schema:
 *               type: string
 */
graphRouter.get(
  '/dependencies/svg',
  asyncHandler(async (_req: Request, res: Response) => {
    const graph = await buildContractDependencyGraph();
    const svg = generateDependencyGraphSVG(graph);
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  }),
);

/**
 * @swagger
 * /api/v1/graph/contracts/{address}/upstream:
 *   get:
 *     summary: BFS upstream dependency walk (who depends on this contract?)
 *     tags: [Graph]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Seed contract address
 *       - in: query
 *         name: maxDepth
 *         schema: { type: integer, default: 10, minimum: 1, maximum: 50 }
 *       - in: query
 *         name: maxNodes
 *         schema: { type: integer, default: 5000, minimum: 1, maximum: 50000 }
 *       - in: query
 *         name: timeoutMs
 *         schema: { type: integer, default: 10000, minimum: 100, maximum: 30000 }
 *     responses:
 *       200:
 *         description: Upstream BFS result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GraphTraversalResult'
 */
graphRouter.get(
  '/contracts/:address/upstream',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const opts = parseOpts(req.query as Record<string, unknown>);
    const result = await upstreamBfs(address, opts);
    res.json(result);
  }),
);

/**
 * @swagger
 * /api/v1/graph/contracts/{address}/downstream:
 *   get:
 *     summary: BFS downstream dependency walk (what does this contract depend on?)
 *     tags: [Graph]
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *         description: Seed contract address
 *       - in: query
 *         name: maxDepth
 *         schema: { type: integer, default: 10, minimum: 1, maximum: 50 }
 *       - in: query
 *         name: maxNodes
 *         schema: { type: integer, default: 5000, minimum: 1, maximum: 50000 }
 *       - in: query
 *         name: timeoutMs
 *         schema: { type: integer, default: 10000, minimum: 100, maximum: 30000 }
 *     responses:
 *       200:
 *         description: Downstream BFS result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/GraphTraversalResult'
 */
graphRouter.get(
  '/contracts/:address/downstream',
  asyncHandler(async (req: Request, res: Response) => {
    const { address } = req.params;
    const opts = parseOpts(req.query as Record<string, unknown>);
    const result = await downstreamBfs(address, opts);
    res.json(result);
  }),
);
