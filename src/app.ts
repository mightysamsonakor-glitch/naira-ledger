import express, { type Request, type Response, type NextFunction } from 'express';
import swaggerUi from 'swagger-ui-express';
import { z } from 'zod';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { idempotent } from './idempotency.js';
import { openapi } from './openapi.js';
import {
  LedgerError,
  createAccount,
  deposit,
  getAccount,
  getStatement,
  transfer,
  trialBalance,
} from './ledger.js';

type RawRequest = Request & { rawBody?: Buffer };

const uuid = z.string().uuid();
const kobo = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(100),
  currency: z.string().length(3).toUpperCase().default('NGN'),
});

const transferSchema = z.object({
  from: uuid,
  to: uuid,
  amount: kobo,
  reference: z.string().min(1).max(100).optional(),
  description: z.string().max(200).optional(),
});

export function createApp() {
  const app = express();

  // Keep the raw body: webhook signatures are computed over the exact bytes sent.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as RawRequest).rawBody = buf;
      },
    }),
  );

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));
  app.get('/openapi.json', (_req, res) => res.json(openapi));

  app.get('/health', async (_req, res) => {
    const total = await trialBalance();
    res.status(total === 0 ? 200 : 500).json({ status: total === 0 ? 'ok' : 'ledger_unbalanced', trial_balance: total });
  });

  app.post('/accounts', async (req, res) => {
    const body = createAccountSchema.parse(req.body);
    res.status(201).json(await createAccount(body.name, body.currency));
  });

  app.get('/accounts/:id', async (req, res) => {
    const id = uuid.parse(req.params.id);
    const account = await getAccount(id);
    if (!account) throw new LedgerError(404, 'account_not_found', 'Account not found');
    res.json(account);
  });

  app.get('/accounts/:id/transactions', async (req, res) => {
    const id = uuid.parse(req.params.id);
    if (!(await getAccount(id))) throw new LedgerError(404, 'account_not_found', 'Account not found');
    res.json({ data: await getStatement(id) });
  });

  app.post('/transfers', idempotent(), async (req, res) => {
    const body = transferSchema.parse(req.body);
    const result = await transfer({
      fromId: body.from,
      toId: body.to,
      amount: body.amount,
      reference: body.reference ?? `TRF-${req.header('Idempotency-Key')}`,
      description: body.description,
    });
    res.status(201).json(result);
  });

  /**
   * Paystack-style webhook: `x-paystack-signature` is HMAC-SHA512 of the raw body
   * using your secret key. Duplicate deliveries of the same reference are ignored.
   */
  app.post('/webhooks/paystack', async (req: RawRequest, res) => {
    const signature = req.header('x-paystack-signature') ?? '';
    const expected = createHmac('sha512', config.webhookSecret).update(req.rawBody ?? '').digest('hex');
    const valid =
      signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    if (!valid) return res.status(401).json({ error: 'invalid_signature' });

    const event = req.body;
    if (event?.event !== 'charge.success') return res.status(200).json({ received: true, ignored: true });

    const parsed = z
      .object({
        reference: z.string().min(1),
        amount: kobo,
        metadata: z.object({ account_id: uuid }),
      })
      .safeParse(event.data);
    // Acknowledge malformed events so the provider stops retrying them.
    if (!parsed.success) return res.status(200).json({ received: true, ignored: true, reason: 'invalid_payload' });

    const { reference, amount, metadata } = parsed.data;
    const result = await deposit(metadata.account_id, amount, `PSK-${reference}`);
    res.status(200).json({ received: true, duplicate: result === null });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation_error', issues: err.issues });
    }
    if (err instanceof LedgerError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    if ((err as any)?.code === '23505') {
      return res.status(409).json({ error: 'duplicate_reference', message: 'A transaction with this reference already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
