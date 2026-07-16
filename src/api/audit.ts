/**
 * Smart Contract Audit Trail & Certificate API
 * All routes mounted at /api/v1/audit
 *
 * Certificate endpoints
 * ─────────────────────────────────────────────────────────────────
 * GET  /contracts/:address/certificate        latest published certificate
 * GET  /contracts/:address/certificate/history all versions
 * POST /contracts/:address/audit              trigger a new audit
 * GET  /contracts/:address/audit/status       check in-progress audit status
 * GET  /contracts/:address/report.txt         regulatory-grade text report download
 *
 * Findings
 * ─────────────────────────────────────────────────────────────────
 * GET  /certificates/:id/findings             list findings for a certificate
 * GET  /findings/:id                          single finding detail
 * PUT  /findings/:id                          update finding status (resolve/wont_fix)
 *
 * Events & trail
 * ─────────────────────────────────────────────────────────────────
 * GET  /contracts/:address/events             append-only event trail
 *
 * Public verification
 * ─────────────────────────────────────────────────────────────────
 * GET  /verify/:hash                          verify a certificate hash (public API)
 *
 * Platform analytics
 * ─────────────────────────────────────────────────────────────────
 * GET  /leaderboard                           ranked by overallScore
 * GET  /stats                                 platform-wide statistics
 *
 * External audits
 * ─────────────────────────────────────────────────────────────────
 * POST /external                              submit an external audit report
 * GET  /external/:contractAddress             list external audits for a contract
 * PUT  /external/:id/verify                   verify / reject a submission
 *
 * Subscriptions
 * ─────────────────────────────────────────────────────────────────
 * POST /subscriptions                         create alert subscription
 * GET  /subscriptions/:userId                 list user's subscriptions
 * DELETE /subscriptions/:id                   cancel subscription
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaRead, prismaWrite } from '../db';
import { cacheGet, cacheSet } from '../cache';
import {
  runAudit,
  verifyCertificateSignature,
  generateReportText,
  needsReaudit,
} from '../indexer/audit-engine';

export const auditRouter = Router();

// ── Shared helpers ────────────────────────────────────────────────────────────

function scoreGrade(s: number): string {
  return s >= 85 ? 'A' : s >= 70 ? 'B' : s >= 55 ? 'C' : s >= 40 ? 'D' : 'F';
}

function scoreRisk(s: number): string {
  return s >= 85 ? 'low' : s >= 70 ? 'medium' : s >= 55 ? 'high' : 'critical';
}

function certStatus(cert: { status: string; expiresAt: Date | null }): string {
  if (cert.status === 'revoked')    return 'revoked';
  if (cert.status === 'superseded') return 'superseded';
  if (cert.expiresAt && cert.expiresAt < new Date()) return 'expired';
  return cert.status; // "published" | "draft"
}

function formatCert(cert: Record<string, unknown>) {
  const score = cert.overallScore as number;
  return {
    id:              cert.id,
    contractAddress: cert.contractAddress,
    version:         cert.version,
    status:          certStatus(cert as { status: string; expiresAt: Date | null }),
    grade:           scoreGrade(score),
    riskLevel:       scoreRisk(score),
    scores: {
      overall:    cert.overallScore,
      security:   cert.securityScore,
      governance: cert.governanceScore,
      economic:   cert.economicScore,
      compliance: cert.complianceScore,
      liquidity:  cert.liquidityScore,
    },
    findings: {
      total:    cert.totalFindings,
      open:     cert.openFindings,
      critical: cert.criticalFindings,
      high:     cert.highFindings,
      medium:   cert.mediumFindings,
      low:      cert.lowFindings,
      resolved: cert.resolvedFindings,
    },
    cryptography: {
      algorithm:       cert.signatureAlgorithm,
      publicKey:       cert.publicKey,
      certificateHash: cert.certificateHash,
      anchorTxHash:    cert.anchorTxHash,
      verifyUrl:       `/api/v1/audit/verify/${cert.certificateHash}`,
    },
    generatedAt: cert.generatedAt,
    expiresAt:   cert.expiresAt,
    createdAt:   cert.createdAt,
    metadata:    cert.metadata,
  };
}

// ── GET /contracts/:address/certificate ───────────────────────────────────────

auditRouter.get('/contracts/:address/certificate', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const cacheKey = `audit:cert:latest:${address}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
    });

    if (!cert) {
      // Check if there's a non-published one
      const any = await prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address },
        orderBy: { version: 'desc' },
        select: { id: true, status: true, version: true },
      });

      return res.status(404).json({
        error: 'No published audit certificate found for this contract.',
        existingStatus: any?.status ?? null,
        hint: `POST /api/v1/audit/contracts/${address}/audit to trigger one.`,
      });
    }

    const result = formatCert(cert as unknown as Record<string, unknown>);
    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/certificate/history ───────────────────────────────

auditRouter.get('/contracts/:address/certificate/history', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

    const certs = await prismaRead.auditCertificate.findMany({
      where: { contractAddress: address },
      orderBy: { version: 'desc' },
      take: limit,
      select: {
        id: true, version: true, status: true, generatedAt: true, expiresAt: true,
        overallScore: true, securityScore: true, governanceScore: true,
        economicScore: true, complianceScore: true, liquidityScore: true,
        totalFindings: true, criticalFindings: true, highFindings: true,
        certificateHash: true, anchorTxHash: true, createdAt: true,
      },
    });

    res.json({
      contractAddress: address,
      count: certs.length,
      history: certs.map((c) => ({
        ...c,
        grade:     scoreGrade(c.overallScore),
        riskLevel: scoreRisk(c.overallScore),
        status:    certStatus(c as { status: string; expiresAt: Date | null }),
        verifyUrl: `/api/v1/audit/verify/${c.certificateHash}`,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /contracts/:address/audit — trigger a new audit ──────────────────────

const triggerSchema = z.object({
  force:         z.boolean().default(false),
  triggerSource: z.enum(['manual', 'external']).default('manual'),
});

auditRouter.post('/contracts/:address/audit', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { force, triggerSource } = triggerSchema.parse(req.body);

    // Guard against auditing unknown contracts
    const contract = await prismaRead.contract.findUnique({
      where: { address }, select: { address: true },
    });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found in explorer index.' });
    }

    if (!force) {
      const alreadyNeeded = await needsReaudit(address);
      if (!alreadyNeeded) {
        const latest = await prismaRead.auditCertificate.findFirst({
          where: { contractAddress: address, status: 'published' },
          orderBy: { version: 'desc' },
          select: { id: true, version: true, overallScore: true, expiresAt: true, certificateHash: true },
        });
        if (latest) {
          return res.status(200).json({
            message: 'Certificate is up-to-date. Pass force=true to re-audit anyway.',
            certificate: {
              id: latest.id,
              version: latest.version,
              overallScore: latest.overallScore,
              expiresAt: latest.expiresAt,
              verifyUrl: `/api/v1/audit/verify/${latest.certificateHash}`,
            },
          });
        }
      }
    }

    // Fire audit asynchronously — respond with 202 immediately
    const nextVersion = (await prismaRead.auditCertificate.count({
      where: { contractAddress: address },
    })) + 1;

    res.status(202).json({
      message: 'Audit triggered. Certificate will be available shortly.',
      contractAddress: address,
      expectedVersion: nextVersion,
      statusUrl: `/api/v1/audit/contracts/${address}/certificate`,
      eventsUrl: `/api/v1/audit/contracts/${address}/events`,
    });

    // Background execution
    runAudit(address, triggerSource).catch((e) =>
      logger.error('Manual audit failed', { address, error: String(e) }),
    );
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// Lazy import logger to avoid circular deps in the route file
import { logger } from '../logger';

// ── GET /contracts/:address/audit/status ─────────────────────────────────────

auditRouter.get('/contracts/:address/audit/status', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const [latest, eventCount, lastEvent] = await Promise.all([
      prismaRead.auditCertificate.findFirst({
        where: { contractAddress: address },
        orderBy: { version: 'desc' },
        select: {
          id: true, version: true, status: true, overallScore: true,
          generatedAt: true, expiresAt: true, certificateHash: true,
        },
      }),
      prismaRead.auditEvent.count({ where: { contractAddress: address } }),
      prismaRead.auditEvent.findFirst({
        where: { contractAddress: address },
        orderBy: { timestamp: 'desc' },
        select: { eventType: true, timestamp: true, triggerSource: true },
      }),
    ]);

    if (!latest) {
      return res.json({
        contractAddress: address,
        audited: false,
        message: 'No audit has been run for this contract yet.',
        hint: `POST /api/v1/audit/contracts/${address}/audit to start one.`,
      });
    }

    const resolvedStatus = certStatus(latest as { status: string; expiresAt: Date | null });

    res.json({
      contractAddress: address,
      audited: true,
      latestVersion: latest.version,
      status: resolvedStatus,
      overallScore: latest.overallScore,
      grade: scoreGrade(latest.overallScore),
      riskLevel: scoreRisk(latest.overallScore),
      generatedAt: latest.generatedAt,
      expiresAt: latest.expiresAt,
      needsReaudit: await needsReaudit(address),
      certificateHash: latest.certificateHash,
      verifyUrl: `/api/v1/audit/verify/${latest.certificateHash}`,
      auditEventCount: eventCount,
      lastEvent,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/report.txt ────────────────────────────────────────

auditRouter.get('/contracts/:address/report.txt', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { contractAddress: address, status: 'published' },
      orderBy: { version: 'desc' },
    });

    if (!cert) {
      return res.status(404).send('No published audit certificate found for this contract.');
    }

    const text = generateReportText({
      contractAddress: cert.contractAddress,
      version:         cert.version,
      status:          cert.status,
      generatedAt:     cert.generatedAt,
      expiresAt:       cert.expiresAt,
      overallScore:    cert.overallScore,
      securityScore:   cert.securityScore,
      governanceScore: cert.governanceScore,
      economicScore:   cert.economicScore,
      complianceScore: cert.complianceScore,
      liquidityScore:  cert.liquidityScore,
      certificateHash: cert.certificateHash,
      anchorTxHash:    cert.anchorTxHash,
      totalFindings:   cert.totalFindings,
      criticalFindings: cert.criticalFindings,
      highFindings:    cert.highFindings,
      mediumFindings:  cert.mediumFindings,
      lowFindings:     cert.lowFindings,
      openFindings:    cert.openFindings,
      resolvedFindings: cert.resolvedFindings,
      scores:          cert.scores,
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-${address.slice(0, 12)}-v${cert.version}.txt"`,
    );
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /certificates/:id/findings ───────────────────────────────────────────

const findingsQuerySchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']).optional(),
  category: z.enum(['vulnerability', 'code_quality', 'governance', 'economics', 'compliance', 'liquidity']).optional(),
  status:   z.enum(['open', 'resolved', 'wont_fix', 'false_positive']).optional(),
  page:     z.coerce.number().min(1).default(1),
  limit:    z.coerce.number().min(1).max(100).default(20),
});

auditRouter.get('/certificates/:id/findings', async (req: Request, res: Response) => {
  try {
    const q = findingsQuerySchema.parse(req.query);
    const skip = (q.page - 1) * q.limit;

    // Verify certificate exists
    const cert = await prismaRead.auditCertificate.findUnique({
      where: { id: req.params.id },
      select: { id: true, contractAddress: true, version: true, overallScore: true },
    });
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });

    const where: Record<string, unknown> = { certificateId: req.params.id };
    if (q.severity) where.severity = q.severity;
    if (q.category) where.category = q.category;
    if (q.status)   where.status   = q.status;

    const [findings, total] = await Promise.all([
      prismaRead.auditFinding.findMany({
        where,
        orderBy: [
          { severity: 'asc' }, // critical < high < medium sorts alphabetically — use raw sort below
          { createdAt: 'desc' },
        ],
        skip,
        take: q.limit,
      }),
      prismaRead.auditFinding.count({ where }),
    ]);

    // Sort critical → high → medium → low → info
    const sevOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const sorted = findings.sort(
      (a, b) => sevOrder.indexOf(a.severity) - sevOrder.indexOf(b.severity),
    );

    res.json({
      certificateId: req.params.id,
      contractAddress: cert.contractAddress,
      version: cert.version,
      data: sorted,
      total,
      page: q.page,
      limit: q.limit,
      pages: Math.ceil(total / q.limit),
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /findings/:id ─────────────────────────────────────────────────────────

auditRouter.get('/findings/:id', async (req: Request, res: Response) => {
  try {
    const finding = await prismaRead.auditFinding.findUnique({
      where: { id: req.params.id },
      include: {
        certificate: {
          select: { contractAddress: true, version: true, overallScore: true },
        },
      },
    });
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    res.json(finding);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /findings/:id — update status ────────────────────────────────────────

const findingUpdateSchema = z.object({
  status:         z.enum(['resolved', 'wont_fix', 'false_positive']),
  resolutionNote: z.string().optional(),
});

auditRouter.put('/findings/:id', async (req: Request, res: Response) => {
  try {
    const data = findingUpdateSchema.parse(req.body);

    const finding = await prismaRead.auditFinding.findUnique({
      where: { id: req.params.id },
      select: { id: true, certificateId: true, status: true },
    });
    if (!finding) return res.status(404).json({ error: 'Finding not found.' });
    if (finding.status !== 'open') {
      return res.status(409).json({
        error: `Finding is already ${finding.status}. Only open findings can be updated.`,
      });
    }

    const updated = await prismaWrite.auditFinding.update({
      where: { id: req.params.id },
      data: {
        status:         data.status,
        resolutionNote: data.resolutionNote,
        resolvedAt:     data.status === 'resolved' ? new Date() : null,
      },
    });

    // Keep certificate counters consistent
    if (data.status === 'resolved') {
      await prismaWrite.auditCertificate.update({
        where: { id: finding.certificateId },
        data: {
          openFindings:     { decrement: 1 },
          resolvedFindings: { increment: 1 },
        },
      });
    } else {
      // wont_fix / false_positive — close the open count
      await prismaWrite.auditCertificate.update({
        where: { id: finding.certificateId },
        data: { openFindings: { decrement: 1 } },
      });
    }

    res.json(updated);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /contracts/:address/events ────────────────────────────────────────────

auditRouter.get('/contracts/:address/events', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const eventType = req.query.eventType as string | undefined;

    const where: Record<string, unknown> = { contractAddress: address };
    if (eventType) where.eventType = eventType;

    const [events, total] = await Promise.all([
      prismaRead.auditEvent.findMany({
        where,
        orderBy: { timestamp: 'desc' },
        take: limit,
      }),
      prismaRead.auditEvent.count({ where }),
    ]);

    res.json({
      contractAddress: address,
      total,
      returned: events.length,
      events,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /verify/:hash — public certificate verification ───────────────────────

auditRouter.get('/verify/:hash', async (req: Request, res: Response) => {
  try {
    const { hash } = req.params;

    const cert = await prismaRead.auditCertificate.findFirst({
      where: { certificateHash: hash },
      orderBy: { version: 'desc' },
      select: {
        id: true, contractAddress: true, version: true, status: true,
        overallScore: true, securityScore: true, governanceScore: true,
        economicScore: true, complianceScore: true, liquidityScore: true,
        signature: true, publicKey: true, signatureAlgorithm: true,
        generatedAt: true, expiresAt: true, anchorTxHash: true,
        certificateHash: true, totalFindings: true, criticalFindings: true,
      },
    });

    let result: string;
    let detail: Record<string, unknown> = {};

    if (!cert) {
      result = 'invalid';
      detail = { reason: 'Certificate hash not found in registry.' };
    } else {
      const sigValid  = verifyCertificateSignature(cert.certificateHash, cert.signature);
      const isExpired = !!cert.expiresAt && cert.expiresAt < new Date();
      const isRevoked = cert.status === 'revoked';

      result = !sigValid ? 'invalid' : isRevoked ? 'revoked' : isExpired ? 'expired' : 'valid';

      detail = {
        contractAddress:    cert.contractAddress,
        version:            cert.version,
        signatureValid:     sigValid,
        signatureAlgorithm: cert.signatureAlgorithm,
        publicKey:          cert.publicKey,
        isExpired,
        isRevoked,
        overallScore:       cert.overallScore,
        grade:              scoreGrade(cert.overallScore),
        riskLevel:          scoreRisk(cert.overallScore),
        scores: {
          security:   cert.securityScore,
          governance: cert.governanceScore,
          economic:   cert.economicScore,
          compliance: cert.complianceScore,
          liquidity:  cert.liquidityScore,
        },
        totalFindings:    cert.totalFindings,
        criticalFindings: cert.criticalFindings,
        generatedAt:      cert.generatedAt,
        expiresAt:        cert.expiresAt,
        anchorTxHash:     cert.anchorTxHash,
      };
    }

    // Record the verification attempt
    await prismaWrite.auditVerificationRecord.create({
      data: {
        certificateHash: hash,
        verifierIp:  req.ip ?? null,
        verifierKey: (req.headers['x-api-key'] as string) ?? null,
        result,
      },
    });

    res.json({ certificateHash: hash, result, verifiedAt: new Date().toISOString(), ...detail });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /leaderboard ──────────────────────────────────────────────────────────

auditRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const order  = req.query.order === 'asc' ? 'asc' : 'desc';
    const limit  = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const cacheKey = `audit:leaderboard:${order}:${limit}`;

    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const certs = await prismaRead.auditCertificate.findMany({
      where: { status: 'published' },
      orderBy: { overallScore: order },
      take: limit,
      select: {
        id: true, contractAddress: true, version: true,
        overallScore: true, securityScore: true, governanceScore: true,
        economicScore: true, complianceScore: true, liquidityScore: true,
        totalFindings: true, criticalFindings: true, highFindings: true,
        certificateHash: true, generatedAt: true,
      },
    });

    const result = {
      order: order === 'desc' ? 'riskiest_first' : 'safest_first',
      count: certs.length,
      contracts: certs.map((c, idx) => ({
        rank:            idx + 1,
        contractAddress: c.contractAddress,
        version:         c.version,
        overallScore:    c.overallScore,
        grade:           scoreGrade(c.overallScore),
        riskLevel:       scoreRisk(c.overallScore),
        scores: {
          security:   c.securityScore,
          governance: c.governanceScore,
          economic:   c.economicScore,
          compliance: c.complianceScore,
          liquidity:  c.liquidityScore,
        },
        totalFindings:    c.totalFindings,
        criticalFindings: c.criticalFindings,
        highFindings:     c.highFindings,
        certificateHash:  c.certificateHash,
        verifyUrl:        `/api/v1/audit/verify/${c.certificateHash}`,
        auditedAt:        c.generatedAt,
      })),
    };

    await cacheSet(cacheKey, result, 600);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────

auditRouter.get('/stats', async (_req: Request, res: Response) => {
  try {
    const cacheKey = 'audit:platform:stats';
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const since30d = new Date(Date.now() - 30 * 86400000);

    const [
      totalCerts,
      activeCerts,
      avgScores,
      verificationCount,
      findingsBySeverity,
      recentCerts,
      eventCounts,
      externalAuditCount,
    ] = await Promise.all([
      prismaRead.auditCertificate.count(),
      prismaRead.auditCertificate.count({ where: { status: 'published' } }),
      prismaRead.auditCertificate.aggregate({
        where: { status: 'published' },
        _avg: {
          overallScore: true, securityScore: true, governanceScore: true,
          economicScore: true, complianceScore: true, liquidityScore: true,
        },
        _min: { overallScore: true },
        _max: { overallScore: true },
      }),
      prismaRead.auditVerificationRecord.count(),
      prismaRead.auditFinding.groupBy({
        by: ['severity'],
        _count: { id: true },
        where: { status: 'open' },
      }),
      prismaRead.auditCertificate.findMany({
        where: { status: 'published' },
        orderBy: { generatedAt: 'desc' },
        take: 5,
        select: {
          contractAddress: true, overallScore: true,
          generatedAt: true, version: true, criticalFindings: true,
        },
      }),
      prismaRead.auditEvent.groupBy({
        by: ['eventType'],
        where: { timestamp: { gte: since30d } },
        _count: { id: true },
      }),
      prismaRead.externalAudit.count(),
    ]);

    const findingMap: Record<string, number> = {};
    for (const f of findingsBySeverity) findingMap[f.severity] = f._count.id;

    const eventMap: Record<string, number> = {};
    for (const e of eventCounts) eventMap[e.eventType] = e._count.id;

    const result = {
      certificates: {
        total:  totalCerts,
        active: activeCerts,
      },
      averageScores: {
        overall:    +(avgScores._avg.overallScore    ?? 0).toFixed(1),
        security:   +(avgScores._avg.securityScore   ?? 0).toFixed(1),
        governance: +(avgScores._avg.governanceScore ?? 0).toFixed(1),
        economic:   +(avgScores._avg.economicScore   ?? 0).toFixed(1),
        compliance: +(avgScores._avg.complianceScore ?? 0).toFixed(1),
        liquidity:  +(avgScores._avg.liquidityScore  ?? 0).toFixed(1),
        min:        avgScores._min.overallScore ?? 0,
        max:        avgScores._max.overallScore ?? 0,
      },
      openFindings: {
        critical: findingMap['critical'] ?? 0,
        high:     findingMap['high']     ?? 0,
        medium:   findingMap['medium']   ?? 0,
        low:      findingMap['low']      ?? 0,
        info:     findingMap['info']     ?? 0,
      },
      publicVerifications: verificationCount,
      externalAudits: externalAuditCount,
      activityLast30d: eventMap,
      recentAudits: recentCerts.map((c) => ({
        contractAddress: c.contractAddress,
        overallScore:    c.overallScore,
        grade:           scoreGrade(c.overallScore),
        riskLevel:       scoreRisk(c.overallScore),
        criticalFindings: c.criticalFindings,
        auditedAt:       c.generatedAt,
        version:         c.version,
      })),
      platform: {
        name:               'Soroban Smart Block Explorer — Continuous Audit Platform v2',
        signingAlgorithm:   'HMAC-SHA256 (ed25519 label)',
        publicKeyId:        'soroban-explorer-audit-platform-v1',
        certificateValidity: '90 days',
        scoreWeights: {
          security: '30%', governance: '25%',
          economic: '20%', compliance: '15%', liquidity: '10%',
        },
      },
    };

    await cacheSet(cacheKey, result, 300);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /external — submit external audit ───────────────────────────────────

const externalAuditSchema = z.object({
  contractAddress:        z.string().min(1),
  auditorName:            z.string().min(2).max(200),
  auditorVerificationKey: z.string().optional(),
  reportType:             z.enum(['security_audit', 'formal_verification', 'economic_audit']),
  reportUrl:              z.string().url().optional(),
  reportHash:             z.string().optional(),
  findings:               z.array(z.object({
    severity:       z.enum(['critical', 'high', 'medium', 'low', 'info']),
    title:          z.string(),
    description:    z.string(),
    recommendation: z.string().optional(),
  })).optional(),
  overallGrade: z.enum(['pass', 'conditional_pass', 'fail']).optional(),
  submittedAt:  z.string().datetime(),
});

auditRouter.post('/external', async (req: Request, res: Response) => {
  try {
    const data = externalAuditSchema.parse(req.body);

    const submission = await prismaWrite.externalAudit.create({
      data: {
        contractAddress:        data.contractAddress,
        auditorName:            data.auditorName,
        auditorVerificationKey: data.auditorVerificationKey,
        reportType:             data.reportType,
        reportUrl:              data.reportUrl,
        reportHash:             data.reportHash,
        findings:               (data.findings ?? []) as import('@prisma/client').Prisma.InputJsonValue,
        overallGrade:           data.overallGrade,
        submittedAt:            new Date(data.submittedAt),
        verificationStatus:     'pending',
      },
    });

    // Log an audit event for this submission
    await prismaWrite.auditEvent.create({
      data: {
        contractAddress: data.contractAddress,
        eventType:       'external_audit_submitted',
        triggerSource:   'external',
        timestamp:       new Date(),
        details: {
          externalAuditId: submission.id,
          auditorName:     data.auditorName,
          reportType:      data.reportType,
          overallGrade:    data.overallGrade ?? null,
          findingCount:    (data.findings ?? []).length,
        } as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    res.status(201).json({
      id:             submission.id,
      contractAddress: data.contractAddress,
      status:         'pending',
      message:        'External audit submission received and queued for verification.',
    });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /external/:contractAddress ────────────────────────────────────────────

auditRouter.get('/external/:contractAddress', async (req: Request, res: Response) => {
  try {
    const { contractAddress } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const [submissions, total] = await Promise.all([
      prismaRead.externalAudit.findMany({
        where: { contractAddress },
        orderBy: { submittedAt: 'desc' },
        take: limit,
      }),
      prismaRead.externalAudit.count({ where: { contractAddress } }),
    ]);

    res.json({ contractAddress, total, data: submissions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── PUT /external/:id/verify ──────────────────────────────────────────────────

const verifyExternalSchema = z.object({
  decision: z.enum(['verified', 'rejected']),
  notes:    z.string().optional(),
});

auditRouter.put('/external/:id/verify', async (req: Request, res: Response) => {
  try {
    const data = verifyExternalSchema.parse(req.body);

    const submission = await prismaRead.externalAudit.findUnique({
      where: { id: req.params.id },
      select: { id: true, verificationStatus: true, contractAddress: true },
    });
    if (!submission) return res.status(404).json({ error: 'External audit not found.' });
    if (submission.verificationStatus !== 'pending') {
      return res.status(409).json({
        error: `Submission is already ${submission.verificationStatus}.`,
      });
    }

    const updated = await prismaWrite.externalAudit.update({
      where: { id: req.params.id },
      data: {
        verificationStatus: data.decision,
        verifiedAt:         data.decision === 'verified' ? new Date() : null,
      },
    });

    res.json({ id: req.params.id, verificationStatus: updated.verificationStatus });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /subscriptions ───────────────────────────────────────────────────────

const subscriptionSchema = z.object({
  contractAddress: z.string().min(1),
  alertTypes:      z.array(
    z.enum(['score_drop', 'new_finding', 'upgrade', 'certificate_update'])
  ).min(1),
  threshold: z.coerce.number().int().min(1).max(100).optional(),
  userId:    z.string().optional(),
});

auditRouter.post('/subscriptions', async (req: Request, res: Response) => {
  try {
    const data = subscriptionSchema.parse(req.body);

    const sub = await prismaWrite.auditSubscription.create({
      data: {
        contractAddress: data.contractAddress,
        alertTypes:      data.alertTypes,
        threshold:       data.threshold,
        userId:          data.userId,
        isActive:        true,
      },
    });

    res.status(201).json(sub);
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /subscriptions/:userId ────────────────────────────────────────────────

auditRouter.get('/subscriptions/:userId', async (req: Request, res: Response) => {
  try {
    const subs = await prismaRead.auditSubscription.findMany({
      where: { userId: req.params.userId, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ userId: req.params.userId, count: subs.length, subscriptions: subs });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── DELETE /subscriptions/:id ─────────────────────────────────────────────────

auditRouter.delete('/subscriptions/:id', async (req: Request, res: Response) => {
  try {
    const sub = await prismaRead.auditSubscription.findUnique({
      where: { id: req.params.id }, select: { id: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    await prismaWrite.auditSubscription.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });

    res.json({ success: true, id: req.params.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /certificates/:id — fetch full certificate by id ──────────────────────

auditRouter.get('/certificates/:id', async (req: Request, res: Response) => {
  try {
    const cert = await prismaRead.auditCertificate.findUnique({
      where: { id: req.params.id },
    });
    if (!cert) return res.status(404).json({ error: 'Certificate not found.' });
    res.json(formatCert(cert as unknown as Record<string, unknown>));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── POST /contracts/:address/audit/refresh — manual trigger ──────────────────
// Canonical manual re-audit endpoint per spec.
// Alias: also handles POST /contracts/:address/audit (already defined above)
// so this adds the /refresh variant explicitly.

const refreshSchema = z.object({
  mode:   z.enum(['full', 'incremental']).default('full'),
  anchor: z.boolean().default(false),
  reason: z.string().max(500).optional(),
});

auditRouter.post('/contracts/:address/audit/refresh', async (req: Request, res: Response) => {
  try {
    const { address } = req.params;
    const { mode, anchor, reason } = refreshSchema.parse(req.body);

    const contract = await prismaRead.contract.findUnique({
      where: { address }, select: { address: true },
    });
    if (!contract) {
      return res.status(404).json({ error: 'Contract not found in explorer index.' });
    }

    // Return 202 immediately, run pipeline in background
    const nextVersion = (await prismaRead.auditCertificate.count({
      where: { contractAddress: address },
    })) + 1;

    res.status(202).json({
      message: 'Manual audit refresh queued.',
      contractAddress: address,
      mode,
      anchor,
      reason: reason ?? null,
      expectedVersion: nextVersion,
      statusUrl:  `/api/v1/audit/contracts/${address}/audit/status`,
      resultsUrl: `/api/v1/audit/contracts/${address}/certificate`,
      eventsUrl:  `/api/v1/audit/contracts/${address}/events`,
    });

    // Background pipeline execution
    import('../indexer/audit-pipeline').then(({ runAuditPipeline }) =>
      runAuditPipeline({
        contractAddress: address,
        trigger: 'manual',
        mode,
        anchor,
        calledBy: (req.headers['x-api-key'] as string) ?? req.ip ?? 'anonymous',
      }).catch((e) => logger.error('Manual refresh failed', { address, error: String(e) })),
    ).catch((e) => logger.error('Pipeline import failed', { error: String(e) }));
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

// ── GET /pipeline/status — operational health of the audit pipeline ───────────

auditRouter.get('/pipeline/status', async (_req: Request, res: Response) => {
  try {
    const since24h = new Date(Date.now() - 86400000);
    const since1h  = new Date(Date.now() - 3600000);

    const [
      totalCerts,
      certs24h,
      events1h,
      openCritical,
      pendingInitial,
      schedulerStatus,
    ] = await Promise.all([
      prismaRead.auditCertificate.count({ where: { status: 'published' } }),
      prismaRead.auditCertificate.count({ where: { createdAt: { gte: since24h } } }),
      prismaRead.auditEvent.count({ where: { timestamp: { gte: since1h } } }),
      prismaRead.auditFinding.count({
        where: { severity: 'critical', status: 'open' },
      }),
      // Contracts discovered but not yet audited
      prismaRead.contract.count({
        where: { auditCerts: { none: {} } },
      }),
      prismaRead.auditEvent.groupBy({
        by: ['triggerSource'],
        where: { timestamp: { gte: since24h } },
        _count: { id: true },
      }),
    ]);

    const schedulerMap: Record<string, number> = {};
    for (const s of schedulerStatus) schedulerMap[s.triggerSource] = s._count.id;

    res.json({
      status: 'operational',
      pipeline: {
        activeCertificates:  totalCerts,
        auditsLast24h:       certs24h,
        eventsLastHour:      events1h,
        openCriticalFindings: openCritical,
        contractsPendingInitialAudit: pendingInitial,
      },
      scheduler: {
        auditsBySource24h: schedulerMap,
        dailyCadence:  'active contracts (TVL > $100K) — every 24h, incremental mode',
        weeklyCadence: 'all other contracts — every 7d, full mode',
      },
      triggers: {
        initial:    'within 5 minutes of first contract detection',
        upgrade:    'immediate on WasmUpgradeHistory record creation',
        dependency: 'immediate when critical ThreatAdvisory added',
        daily:      'TVL > $100K contracts, incremental re-score',
        weekly:     'all other contracts, full recompute',
        manual:     'POST /api/v1/audit/contracts/:address/audit/refresh',
      },
      modes: {
        full:        'all 5 dimensions recomputed from scratch',
        incremental: 'only dimensions with new data since last cert recomputed',
      },
      anchoring: {
        enabled: process.env.AUDIT_ANCHOR_ENABLED === 'true',
        description: 'SHA-256 of certificate payload embedded in Stellar transaction memo',
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});
