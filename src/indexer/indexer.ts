import WebSocket from 'ws';
import { prisma } from '../db';
import { config } from '../config';
import { fetchEvents, getLatestLedger, getRpcWebsocketUrl, getTransaction } from './rpc';
import { decodeTransaction, decodeEvent } from './decoder';

const BATCH = config.indexerBatchSize;

async function getLastIndexedLedger(): Promise<number> {
  const state = await prisma.indexerState.upsert({
    where: { id: 'singleton' },
    update: {},
    create: { id: 'singleton', lastLedger: config.indexerStartLedger },
  });
  return state.lastLedger;
}

async function setLastIndexedLedger(ledger: number) {
  await prisma.indexerState.update({ where: { id: 'singleton' }, data: { lastLedger: ledger } });
}

async function processLedgerRange(start: number, end: number) {
  console.log(`Indexing ledgers ${start} → ${end}`);
  const events = await fetchEvents(start, end);

  for (const event of events) {
    await prisma.contract.upsert({
      where: { address: event.contractId },
      update: {},
      create: { address: event.contractId },
    });

    const existingTx = await prisma.transaction.findUnique({ where: { hash: event.transactionHash } });
    if (!existingTx) {
      const txResult = await getTransaction(event.transactionHash).catch(() => null);
      const rawXdr = (txResult as any)?.envelopeXdr?.toXDR('base64') ?? '';
      const decoded = rawXdr
        ? await decodeTransaction(rawXdr)
        : {
            contractAddress: event.contractId,
            functionName: null,
            functionArgs: null,
            humanReadable: null,
          };

      await prisma.transaction.upsert({
        where: { hash: event.transactionHash },
        update: {},
        create: {
          hash: event.transactionHash,
          ledger: event.ledger,
          ledgerCloseTime: event.ledgerCloseTime,
          sourceAccount: (txResult as any)?.sourceAccount ?? 'unknown',
          contractAddress: decoded.contractAddress,
          functionName: decoded.functionName,
          functionArgs: decoded.functionArgs as object ?? undefined,
          rawXdr,
          status: (txResult as any)?.status === 'SUCCESS' ? 'success' : 'failed',
          humanReadable: decoded.humanReadable,
          feeCharged: String((txResult as any)?.feeCharged ?? ''),
        },
      });
    }

    const { eventType, decoded } = decodeEvent(event.topics, event.data);
    await prisma.event.upsert({
      where: { id: `${event.transactionHash}-${event.topics[0] ?? '0'}` },
      update: {},
      create: {
        id: `${event.transactionHash}-${event.topics[0] ?? '0'}`,
        transactionHash: event.transactionHash,
        contractAddress: event.contractId,
        eventType,
        topics: event.topics,
        data: { raw: event.data },
        decoded: decoded as object,
        ledger: event.ledger,
        ledgerCloseTime: event.ledgerCloseTime,
      },
    });
  }

  console.log(`Processed ${events.length} events in ledgers ${start}–${end}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runIndexer() {
  await startIndexerService();
}

export async function startIndexerService() {
  const worker = new SorobanEventWorker();
  await worker.start();
}

class SorobanEventWorker {
  private websocket?: WebSocket;
  private reconnectDelayMs = 1000;
  private isProcessing = false;
  private shouldStop = false;

  async start() {
    console.log('🔍 Soroban event worker starting...');
    this.connectWebsocket();

    while (!this.shouldStop) {
      try {
        const latest = await getLatestLedger();
        const last = await getLastIndexedLedger();

        if (last < latest) {
          const end = Math.min(last + BATCH, latest);
          await processLedgerRange(last + 1, end);
          await setLastIndexedLedger(end);
        } else {
          await sleep(config.indexerPollIntervalMs);
        }
      } catch (err) {
        console.error('Indexer error:', err);
        await sleep(config.indexerPollIntervalMs);
      }
    }
  }

  private connectWebsocket() {
    const url = getRpcWebsocketUrl();
    console.log(`Connecting Soroban RPC websocket to ${url}`);

    try {
      this.websocket = new WebSocket(url);
      this.websocket.on('open', () => this.handleWsOpen());
      this.websocket.on('message', (data) => this.handleWsMessage(data));
      this.websocket.on('close', (code, reason) => this.handleWsClose(code, reason.toString()));
      this.websocket.on('error', (error) => this.handleWsError(error));
    } catch (error) {
      console.error('Failed to establish websocket connection:', error);
      this.scheduleReconnect();
    }
  }

  private handleWsOpen() {
    console.log('Soroban RPC websocket connected');
    this.reconnectDelayMs = 1000;
    this.subscribeLedgerClose();
  }

  private subscribeLedgerClose() {
    if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const subscribeMessage = {
      jsonrpc: '2.0',
      method: 'subscribe',
      params: { topic: 'ledger' },
      id: 1,
    };

    this.websocket.send(JSON.stringify(subscribeMessage));
  }

  private handleWsMessage(data: WebSocket.Data) {
    const payload = this.dataToString(data);
    if (!payload) {
      return;
    }

    try {
      const message = JSON.parse(payload) as any;
      const ledgerNumber = this.extractLedgerNumber(message);
      if (typeof ledgerNumber === 'number') {
        this.onLedgerClose(ledgerNumber).catch((err) => console.error('Ledger close handler failed:', err));
      }
    } catch (error) {
      console.warn('Failed to parse websocket event payload:', error);
    }
  }

  private extractLedgerNumber(message: any): number | undefined {
    const candidate =
      message?.params?.ledger?.sequence ??
      message?.params?.ledger_sequence ??
      message?.params?.sequence ??
      message?.result?.sequence ??
      message?.result?.ledger?.sequence ??
      message?.ledger;

    const ledger = Number(candidate);
    return Number.isFinite(ledger) && ledger > 0 ? ledger : undefined;
  }

  private async onLedgerClose(ledger: number) {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;
    try {
      const last = await getLastIndexedLedger();
      if (ledger <= last) {
        return;
      }

      console.log(`Ledger close event received for ledger ${ledger}`);
      const end = Math.min(last + BATCH, ledger);
      await processLedgerRange(last + 1, end);
      await setLastIndexedLedger(end);
    } finally {
      this.isProcessing = false;
    }
  }

  private handleWsClose(code: number, reason: string) {
    console.warn(`Soroban RPC websocket closed (${code}) ${reason}`);
    this.scheduleReconnect();
  }

  private handleWsError(error: Error) {
    console.error('Soroban RPC websocket error:', error.message ?? error);
    this.websocket?.close();
  }

  private scheduleReconnect() {
    if (this.shouldStop) {
      return;
    }

    setTimeout(() => this.connectWebsocket(), this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(30000, this.reconnectDelayMs * 2);
  }

  private dataToString(raw: WebSocket.Data): string {
    if (typeof raw === 'string') {
      return raw;
    }

    if (raw instanceof Buffer) {
      return raw.toString('utf8');
    }

    if (raw instanceof ArrayBuffer) {
      return Buffer.from(raw).toString('utf8');
    }

    if (Array.isArray(raw)) {
      return Buffer.concat(raw).toString('utf8');
    }

    return '';
  }
}
