import { Router, Request, Response } from 'express';
import { analyzeResourceTrend } from '../indexer/memory-leak-predictor';

export const resourceAuditRouter = Router();

// GET /audits/resources/:contractAddress
resourceAuditRouter.get('/:contractAddress', async (req: Request, res: Response) => {
  try {
    const analysis = await analyzeResourceTrend(req.params.contractAddress);

    res.json({
      contractAddress: req.params.contractAddress,
      ...analysis,
      systemWarnFlag: analysis.trend === 'critical' || analysis.trend === 'climbing',
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
