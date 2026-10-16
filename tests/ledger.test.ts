import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { migrate } from '../src/migrate.js';
import { pool } from '../src/db.js';
import { config } from '../src/config.js';
import { trialBalance } from '../src/ledger.js';

const app = createApp();

async function openAccount(name: string) {
  const res = await request(app).post('/accounts').send({ name });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function signedWebhook(payload: object) {
  const body = JSON.stringify(payload);
  const sig = createHmac('sha512', config.webhookSecret).update(body).digest('hex');
  return request(app)
    .post('/webhooks/paystack')
    .set('Content-Type', 'application/json')
    .set('x-paystack-signature', sig)
    .send(body);
}

async function fund(accountId: string, amount: number) {
  const res = await signedWebhook({
    event: 'charge.success',
    data: { reference: randomUUID(), amount, metadata: { account_id: accountId } },
  });
  expect(res.status).toBe(200);
}

const balanceOf = async (id: string) => (await request(app).get(`/accounts/${id}`)).body.balance as number;

const transferReq = (body: object, key = randomUUID()) =>
  request(app).post('/transfers').set('Idempotency-Key', key).send(body);

beforeAll(async () => {
  await migrate();
});

afterAll(async () => {
  // The books must balance after every test run.
  expect(await trialBalance()).toBe(0);
  await pool.end();
});

describe('accounts', () => {
  it('opens an account with a zero balance', async () => {
    const res = await request(app).post('/accounts').send({ name: 'Ada' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Ada', currency: 'NGN', kind: 'user', balance: 0 });
  });

  it('validates input', async () => {
    const res = await request(app).post('/accounts').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_error');
  });

  it('returns 404 for unknown accounts', async () => {
    const res = await request(app).get(`/accounts/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});

describe('Paystack webhook', () => {
  it('credits the account on charge.success', async () => {
    const id = await openAccount('Bola');
    await fund(id, 500_000);
    expect(await balanceOf(id)).toBe(500_000);
  });

  it('rejects a bad signature', async () => {
    const res = await request(app)
      .post('/webhooks/paystack')
      .set('x-paystack-signature', 'forged')
      .send({ event: 'charge.success' });
    expect(res.status).toBe(401);
  });

  it('ignores duplicate deliveries of the same reference', async () => {
    const id = await openAccount('Chidi');
    const event = { event: 'charge.success', data: { reference: randomUUID(), amount: 100_000, metadata: { account_id: id } } };
    const first = await signedWebhook(event);
    const second = await signedWebhook(event);
    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(await balanceOf(id)).toBe(100_000);
  });
});

describe('transfers', () => {
  it('moves money and keeps both sides of the entry', async () => {
    const a = await openAccount('Sender');
    const b = await openAccount('Receiver');
    await fund(a, 300_000);

    const res = await transferReq({ from: a, to: b, amount: 120_000, description: 'rent share' });
    expect(res.status).toBe(201);
    expect(await balanceOf(a)).toBe(180_000);
    expect(await balanceOf(b)).toBe(120_000);

    const stmt = await request(app).get(`/accounts/${a}/transactions`);
    expect(stmt.body.data[0]).toMatchObject({ amount: -120_000, kind: 'transfer', description: 'rent share' });
  });

  it('rejects overdrafts', async () => {
    const a = await openAccount('Broke');
    const b = await openAccount('Hopeful');
    const res = await transferReq({ from: a, to: b, amount: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('insufficient_funds');
  });

  it('requires an Idempotency-Key header', async () => {
    const res = await request(app).post('/transfers').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('missing_idempotency_key');
  });

  it('replays the stored response when a request is retried with the same key', async () => {
    const a = await openAccount('Retry A');
    const b = await openAccount('Retry B');
    await fund(a, 100_000);
    const key = randomUUID();
    const body = { from: a, to: b, amount: 40_000 };

    const first = await transferReq(body, key);
    const retry = await transferReq(body, key);

    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replay']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    expect(await balanceOf(a)).toBe(60_000); // charged once, not twice
  });

  it('handles simultaneous duplicate requests with the same key', async () => {
    const a = await openAccount('Double-click A');
    const b = await openAccount('Double-click B');
    await fund(a, 100_000);
    const key = randomUUID();
    const body = { from: a, to: b, amount: 10_000 };

    // A user double-clicking "Send": 5 identical requests land at once.
    const results = await Promise.all(Array.from({ length: 5 }, () => transferReq(body, key)));
    const created = results.filter((r) => r.status === 201 && !r.headers['idempotent-replay']);
    expect(created).toHaveLength(1);
    for (const r of results) {
      expect([201, 409]).toContain(r.status); // 409 = request_in_progress
    }
    expect(await balanceOf(a)).toBe(90_000);
  });

  it('rejects a reused key with a different body', async () => {
    const a = await openAccount('Key A');
    const b = await openAccount('Key B');
    await fund(a, 100_000);
    const key = randomUUID();
    await transferReq({ from: a, to: b, amount: 1_000 }, key);
    const res = await transferReq({ from: a, to: b, amount: 9_000 }, key);
    expect(res.status).toBe(409);
  });

  it('never overspends under concurrent load', async () => {
    const a = await openAccount('Race A');
    const b = await openAccount('Race B');
    await fund(a, 100_000);

    // 20 parallel transfers of 10,000 against a 100,000 balance: exactly 10 may succeed.
    const results = await Promise.all(Array.from({ length: 20 }, () => transferReq({ from: a, to: b, amount: 10_000 })));
    const ok = results.filter((r) => r.status === 201).length;
    const rejected = results.filter((r) => r.status === 422).length;

    expect(ok).toBe(10);
    expect(rejected).toBe(10);
    expect(await balanceOf(a)).toBe(0);
    expect(await balanceOf(b)).toBe(100_000);
  });

  it('does not deadlock on opposite-direction transfers', async () => {
    const a = await openAccount('Ping');
    const b = await openAccount('Pong');
    await fund(a, 50_000);
    await fund(b, 50_000);

    const jobs = Array.from({ length: 20 }, (_, i) =>
      transferReq(i % 2 ? { from: a, to: b, amount: 1_000 } : { from: b, to: a, amount: 1_000 }),
    );
    const results = await Promise.all(jobs);
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect((await balanceOf(a)) + (await balanceOf(b))).toBe(100_000);
  });
});

describe('database guarantees', () => {
  it('refuses unbalanced entries at commit time', async () => {
    const a = await openAccount('Hacker');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO transactions (reference, kind) VALUES ($1, 'deposit') RETURNING id`,
        [randomUUID()],
      );
      await client.query('INSERT INTO entries (transaction_id, account_id, amount) VALUES ($1, $2, 1000000)', [rows[0].id, a]);
      await expect(client.query('COMMIT')).rejects.toThrow(/unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
    expect(await balanceOf(a)).toBe(0);
  });

  it('refuses edits to posted entries', async () => {
    await expect(pool.query('UPDATE entries SET amount = amount * 2')).rejects.toThrow(/append-only/);
  });

  it('reports a zero trial balance on /health', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toEqual({ status: 'ok', trial_balance: 0 });
  });
});
