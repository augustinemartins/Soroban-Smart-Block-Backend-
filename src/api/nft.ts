import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { scrapeContract, scrapeNftMetadata, getCachedNft } from '../indexer/nft-scraper';

export const nftRouter = Router();

// GET /nft/:contract
// Scrape and return all NFT metadata for a contract (uses cache when available).
nftRouter.get('/:contract', async (req: Request, res: Response) => {
  try {
    const results = await scrapeContract(req.params.contract);
    res.json({ data: results, count: results.length });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /nft/:contract/:tokenId
// Return cached metadata for a single token (no network fetch).
nftRouter.get('/:contract/:tokenId', (req: Request, res: Response) => {
  const cached = getCachedNft(req.params.contract, req.params.tokenId);
  if (!cached) return res.status(404).json({ error: 'Not cached — POST to /nft/scrape to fetch' });
  res.json(cached);
});

const scrapeBodySchema = z.object({
  contractAddress: z.string().min(1),
  ledgerEntryXdrs: z.array(z.string()).min(1).max(500),
});

// POST /nft/scrape
// Accept raw ledger-entry XDRs and return scraped + sanitized NFT metadata.
nftRouter.post('/scrape', async (req: Request, res: Response) => {
  try {
    const { contractAddress, ledgerEntryXdrs } = scrapeBodySchema.parse(req.body);
    const results = await scrapeNftMetadata(contractAddress, ledgerEntryXdrs);
    res.json({ data: results, count: results.length });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});
