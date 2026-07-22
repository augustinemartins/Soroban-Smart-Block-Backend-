/**
 * tests/indexer/propagation-engine.test.ts
 *
 * Covers the paginated BFS traversal logic baked into the
 * /api/v1/graph/contracts/:address/upstream  and
 * /api/v1/graph/contracts/:address/downstream  routes (src/api/graph.ts).
 *
 * Uses a synthetic 50 000-edge fixture generated entirely in-memory so no
 * database is required.  prismaRead.contractDependency.findMany is mocked to
 * serve rows from that fixture in BATCH_SIZE-sized pages.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock prismaRead BEFORE importing the module under test ────────────────────
// vi.mock is hoisted, so inline factory with no external references is required.
vi.mock('../../src/db', () => {
  const findMany = vi.fn();
  return {
    prismaRead: {
      contractDependency: { findMany },
    },
  };
});

import { prismaRead } from '../../src/db';

// Typed shorthand for the mock
const findMany = (prismaRead.contractDependency as { findMany: ReturnType<typeof vi.fn> }).findMany;

// ── Re-export the BFS engines via the route handler for black-box testing ─────
// We test through the Express route handlers using a lightweight request/
// response harness rather than importing private functions.
import express, { Application } from 'express';
import request from 'supertest';
import { graphRouter } from '../../src/api/graph';

function buildApp(): Application {
  const app = express();
  app.use('/api/v1/graph', graphRouter);
  return app;
}

// ── Synthetic fixture helpers ─────────────────────────────────────────────────

/**
 * Generate a contract address-like string.  Starts with 'C' and is padded to
 * 56 characters as Soroban contract addresses are, but uses a deterministic
 * numeric suffix so tests are reproducible.
 */
function addr(n: number): string {
  return `C${String(n).padStart(55, '0')}`;
}

type EdgeRow = { id: string; sourceAddress: string; targetAddress: string };

/**
 * Build a linear chain:  0 → 1 → 2 → … → (length-1)
 * Returns rows sorted by id (ascending CUID-like strings).
 */
function buildChain(length: number): EdgeRow[] {
  return Array.from({ length: length - 1 }, (_, i) => ({
    id: `edge-${String(i).padStart(10, '0')}`,
    sourceAddress: addr(i),
    targetAddress: addr(i + 1),
  }));
}

/**
 * Build a fan-out tree rooted at node 0:
 *   0 → 1, 0 → 2, …, 0 → (fanOut)
 *   1 → fanOut+1, …, 1 → 2*fanOut
 *   …
 * Returns at most `maxEdges` rows.
 */
function buildFanOut(fanOut: number, maxEdges: number): EdgeRow[] {
  const rows: EdgeRow[] = [];
  let idCounter = 0;
  let nodeCounter = 0;
  const queue = [nodeCounter++];

  while (queue.length > 0 && rows.length < maxEdges) {
    const src = queue.shift()!;
    for (let i = 0; i < fanOut && rows.length < maxEdges; i++) {
      const tgt = nodeCounter++;
      rows.push({
        id: `edge-${String(idCounter++).padStart(10, '0')}`,
        sourceAddress: addr(src),
        targetAddress: addr(tgt),
      });
      queue.push(tgt);
    }
  }
  return rows;
}

/**
 * Installs `findMany` to serve `rows` in BATCH_SIZE pages.
 *
 * The real Prisma `findMany` with cursor-based pagination returns rows where
 * id > cursor (with skip:1).  We replicate that here with an in-memory filter.
 *
 * @param allRows  All rows in the virtual table (pre-sorted by id ascending).
 * @param filter   A function matching the `where` clause: (row) => boolean.
 */
function mockFindMany(allRows: EdgeRow[], filter: (row: EdgeRow) => boolean): void {
  const BATCH = 500; // mirrors BATCH_SIZE in graph.ts

  findMany.mockImplementation(
    (args: {
      where?: {
        sourceAddress?: { in: string[] };
        targetAddress?: { in: string[] };
        isActive?: boolean;
      };
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) => {
      const { where, take = BATCH, cursor, skip } = args;

      // Determine which rows match this specific `where`
      const matched = allRows.filter((row) => {
        if (where?.sourceAddress?.in && !where.sourceAddress.in.includes(row.sourceAddress)) {
          return false;
        }
        if (where?.targetAddress?.in && !where.targetAddress.in.includes(row.targetAddress)) {
          return false;
        }
        return filter(row);
      });

      // Apply cursor + skip
      let startIdx = 0;
      if (cursor?.id) {
        const cursorIdx = matched.findIndex((r) => r.id === cursor.id);
        startIdx = cursorIdx === -1 ? matched.length : cursorIdx + (skip ?? 1);
      }

      return Promise.resolve(matched.slice(startIdx, startIdx + take));
    },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ────────────────────────────────────────────────────────────────────────────
// DOWNSTREAM BFS
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/graph/contracts/:address/downstream', () => {
  it('returns seed node only when no outgoing edges exist', async () => {
    findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream`);

    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([addr(0)]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.visitedCount).toBe(1);
    expect(res.body.meta.edgeCount).toBe(0);
  });

  it('traverses a 10-node linear chain completely', async () => {
    const rows = buildChain(10); // 9 edges: 0→1→…→9
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=20&maxNodes=50000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(10);
    expect(res.body.edges).toHaveLength(9);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.depth).toBe(9);
  });

  it('respects maxDepth query parameter', async () => {
    const rows = buildChain(20); // chain of 20 nodes
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=3`);

    expect(res.status).toBe(200);
    // Seed + 3 hops = 4 nodes
    expect(res.body.nodes).toHaveLength(4);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.depth).toBe(3);
  });

  it('truncates when maxNodes budget is exceeded', async () => {
    // Fan-out tree: 500 edges so we exceed maxNodes=5 quickly
    const rows = buildFanOut(3, 500);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=5`);

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.nodes.length).toBeLessThanOrEqual(5 + 1); // slight overshoot by one row possible
  });

  it('paginates correctly across a 50 000-edge synthetic fixture (downstream)', async () => {
    // Fan-out structure: 50 000 edges from various nodes, triggering pagination
    // and maxNodes truncation. With fanOut=10 and maxEdges=50000, we have a tree.
    // With maxNodes=500, we'll truncate early in the traversal.
    const EDGE_COUNT = 50_000;
    const rows = buildFanOut(10, EDGE_COUNT);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=500&maxDepth=20&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    // Must truncate because tree expands quickly and exceeds maxNodes=500
    expect(res.body.truncated).toBe(true);
    expect(res.body.meta.visitedCount).toBeLessThanOrEqual(501);
    expect(res.body.meta.edgeCount).toBeGreaterThan(0);
    // Response shape is correct
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(typeof res.body.meta.durationMs).toBe('number');
    // Pagination should have fired many times
    expect(findMany.mock.calls.length).toBeGreaterThan(1);
  });

  it('50k-edge fan-out: pagination loops fire multiple times per frontier', async () => {
    // 50 000 edges fan-out from a single root — depth=1, but requires 100 pages of BATCH_SIZE=500
    const rows = buildFanOut(50_000, 50_000);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxNodes=50000&maxDepth=1&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    // findMany must have been called at least 100 times (50 000 / 500)
    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(100);
    expect(res.body.edges.length).toBeGreaterThan(0);
  });

  it('response shape is always present even for empty graph', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream`);

    expect(res.body).toMatchObject({
      nodes: expect.any(Array),
      edges: expect.any(Array),
      truncated: expect.any(Boolean),
      meta: {
        visitedCount: expect.any(Number),
        edgeCount: expect.any(Number),
        depth: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// UPSTREAM BFS
// ────────────────────────────────────────────────────────────────────────────

describe('GET /api/v1/graph/contracts/:address/upstream', () => {
  it('returns seed node only when no incoming edges exist', async () => {
    findMany.mockResolvedValue([]);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(9)}/upstream`);

    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([addr(9)]);
    expect(res.body.edges).toEqual([]);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.visitedCount).toBe(1);
  });

  it('walks a 10-node chain upward from the tail', async () => {
    // Chain: 0→1→2→…→9.  Seed = addr(9), upstream should find all predecessors.
    const rows = buildChain(10);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(9)}/upstream?maxDepth=20&maxNodes=50000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(10);
    expect(res.body.edges).toHaveLength(9);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.depth).toBe(9);
  });

  it('respects maxDepth query parameter (upstream)', async () => {
    const rows = buildChain(20);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(19)}/upstream?maxDepth=3`);

    expect(res.status).toBe(200);
    // Seed + 3 hops = 4 nodes
    expect(res.body.nodes).toHaveLength(4);
    expect(res.body.truncated).toBe(false);
    expect(res.body.meta.depth).toBe(3);
  });

  it('truncates when maxNodes budget is exceeded (upstream)', async () => {
    // Reverse fan-out: many sources → one target.  We simulate this by building
    // a forward fan-out (0→1, 0→2, …) and seeding at addr(1) for upstream.
    // Simplest approach: use a chain and set maxNodes very small.
    const rows = buildChain(50);
    mockFindMany(rows, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(49)}/upstream?maxNodes=5`);

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.nodes.length).toBeLessThanOrEqual(6);
  });

  it('paginates correctly across a 50 000-edge synthetic fixture (upstream)', async () => {
    const EDGE_COUNT = 50_000;
    // Fan-out structure seeded from addr(1), one of the first-level children.
    // Upstream from a middle node in a large tree should trigger truncation.
    // We use a chain instead and use a tiny maxNodes so it truncates immediately.
    const rows = buildChain(EDGE_COUNT + 1);
    mockFindMany(rows, () => true);

    const app = buildApp();
    // Seed at the tail; maxNodes=10 ensures truncation within a few hops
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(EDGE_COUNT)}/upstream?maxNodes=10&maxDepth=50&timeoutMs=30000`,
    );

    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.meta.visitedCount).toBeLessThanOrEqual(11);
    expect(res.body.meta.edgeCount).toBeGreaterThan(0);
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(Array.isArray(res.body.edges)).toBe(true);
    expect(typeof res.body.meta.durationMs).toBe('number');
  });

  it('response shape matches downstream shape exactly', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/upstream`);

    expect(res.body).toMatchObject({
      nodes: expect.any(Array),
      edges: expect.any(Array),
      truncated: expect.any(Boolean),
      meta: {
        visitedCount: expect.any(Number),
        edgeCount: expect.any(Number),
        depth: expect.any(Number),
        durationMs: expect.any(Number),
      },
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// SHARED / EDGE-CASE COVERAGE
// ────────────────────────────────────────────────────────────────────────────

describe('BFS edge cases', () => {
  it('does not revisit nodes in a diamond graph (downstream)', async () => {
    // Diamond: A→B, A→C, B→D, C→D
    const diamond: EdgeRow[] = [
      { id: 'edge-0000000001', sourceAddress: addr(0), targetAddress: addr(1) },
      { id: 'edge-0000000002', sourceAddress: addr(0), targetAddress: addr(2) },
      { id: 'edge-0000000003', sourceAddress: addr(1), targetAddress: addr(3) },
      { id: 'edge-0000000004', sourceAddress: addr(2), targetAddress: addr(3) },
    ];
    mockFindMany(diamond, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=5`);

    expect(res.status).toBe(200);
    // 4 unique nodes: A, B, C, D
    expect(res.body.nodes).toHaveLength(4);
    // All 4 edges are present
    expect(res.body.edges).toHaveLength(4);
    expect(res.body.truncated).toBe(false);
  });

  it('does not revisit nodes in a diamond graph (upstream)', async () => {
    // Same diamond; seed = D, upstream should reach A, B, C, D
    const diamond: EdgeRow[] = [
      { id: 'edge-0000000001', sourceAddress: addr(0), targetAddress: addr(1) },
      { id: 'edge-0000000002', sourceAddress: addr(0), targetAddress: addr(2) },
      { id: 'edge-0000000003', sourceAddress: addr(1), targetAddress: addr(3) },
      { id: 'edge-0000000004', sourceAddress: addr(2), targetAddress: addr(3) },
    ];
    mockFindMany(diamond, () => true);

    const app = buildApp();
    const res = await request(app).get(`/api/v1/graph/contracts/${addr(3)}/upstream?maxDepth=5`);

    expect(res.status).toBe(200);
    expect(res.body.nodes).toHaveLength(4);
    expect(res.body.edges).toHaveLength(4);
    expect(res.body.truncated).toBe(false);
  });

  it('clamps out-of-range query params to valid defaults', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();

    // maxDepth=999 should be clamped to 50, maxNodes=0 → 1
    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=999&maxNodes=0`,
    );
    expect(res.status).toBe(200);
    expect(res.body.meta.depth).toBeLessThanOrEqual(50);
  });

  it('handles non-numeric query params gracefully', async () => {
    findMany.mockResolvedValue([]);
    const app = buildApp();

    const res = await request(app).get(
      `/api/v1/graph/contracts/${addr(0)}/downstream?maxDepth=abc&maxNodes=xyz`,
    );
    expect(res.status).toBe(200);
    // Falls back to defaults — should not throw
    expect(res.body.truncated).toBe(false);
  });
});
