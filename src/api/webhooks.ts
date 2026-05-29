import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { prismaWrite as prisma, prismaRead } from '../db';

export const webhooksRouter = Router();

const createSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(8).optional(),
  contractAddress: z.string().optional(),
  eventType: z.string().optional(),
  topicSymbol: z.string().optional(),
});

// POST /webhooks — register a new subscription
webhooksRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const sub = await prisma.webhookSubscription.create({ data: parsed.data });
  res.status(201).json(sub);
});

// GET /webhooks — list all subscriptions
webhooksRouter.get('/', async (_req: Request, res: Response) => {
  const subs = await prismaRead.webhookSubscription.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, url: true, contractAddress: true, eventType: true, topicSymbol: true, active: true, createdAt: true },
  });
  res.json({ data: subs });
});

// DELETE /webhooks/:id — remove a subscription
webhooksRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    await prisma.webhookSubscription.delete({ where: { id: req.params.id } });
    res.status(204).end();
  } catch {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// PATCH /webhooks/:id — enable / disable
webhooksRouter.patch('/:id', async (req: Request, res: Response) => {
  const { active } = z.object({ active: z.boolean() }).parse(req.body);
  try {
    const sub = await prisma.webhookSubscription.update({ where: { id: req.params.id }, data: { active } });
    res.json(sub);
  } catch {
    res.status(404).json({ error: 'Subscription not found' });
  }
});

// GET /webhooks/:id/deliveries — delivery history for a subscription
webhooksRouter.get('/:id/deliveries', async (req: Request, res: Response) => {
  const deliveries = await prismaRead.webhookDelivery.findMany({
    where: { subscriptionId: req.params.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  res.json({ data: deliveries });
});
