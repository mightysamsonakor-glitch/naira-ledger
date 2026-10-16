import type { PoolClient } from 'pg';
import { pool, withTransaction } from './db.js';
import { FUNDING_ACCOUNT_ID } from './config.js';

export class LedgerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface Account {
  id: string;
  name: string;
  currency: string;
  kind: 'user' | 'system';
  balance: number; // kobo
  created_at: string;
}

export async function createAccount(name: string, currency = 'NGN'): Promise<Account> {
  const { rows } = await pool.query(
    `INSERT INTO accounts (name, currency) VALUES ($1, $2)
     RETURNING id, name, currency, kind, created_at`,
    [name, currency],
  );
  return { ...rows[0], balance: 0 };
}

export async function getAccount(id: string, client: Pick<PoolClient, 'query'> = pool): Promise<Account | null> {
  const { rows } = await client.query(
    `SELECT a.id, a.name, a.currency, a.kind, a.created_at,
            COALESCE(SUM(e.amount), 0)::BIGINT AS balance
       FROM accounts a
       LEFT JOIN entries e ON e.account_id = a.id
      WHERE a.id = $1
      GROUP BY a.id`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getStatement(accountId: string, limit = 50) {
  const { rows } = await pool.query(
    `SELECT t.id AS transaction_id, t.reference, t.kind, t.description,
            e.amount, e.created_at
       FROM entries e JOIN transactions t ON t.id = e.transaction_id
      WHERE e.account_id = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [accountId, limit],
  );
  return rows;
}

/**
 * Lock the given accounts in a fixed (sorted) order. Two concurrent transfers
 * A->B and B->A therefore lock in the same order and can't deadlock.
 */
async function lockAccounts(client: PoolClient, ids: string[]): Promise<Map<string, Account>> {
  const sorted = [...new Set(ids)].sort();
  const found = new Map<string, Account>();
  for (const id of sorted) {
    const { rowCount } = await client.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [id]);
    if (!rowCount) throw new LedgerError(404, 'account_not_found', `Account ${id} not found`);
    found.set(id, (await getAccount(id, client))!);
  }
  return found;
}

interface PostingInput {
  reference: string;
  kind: 'transfer' | 'deposit';
  description?: string;
  fromId: string;
  toId: string;
  amount: number;
}

async function post(client: PoolClient, p: PostingInput) {
  const accounts = await lockAccounts(client, [p.fromId, p.toId]);
  const from = accounts.get(p.fromId)!;
  const to = accounts.get(p.toId)!;

  if (from.currency !== to.currency) {
    throw new LedgerError(422, 'currency_mismatch', 'Accounts use different currencies');
  }
  if (from.kind === 'user' && from.balance < p.amount) {
    throw new LedgerError(422, 'insufficient_funds', 'Insufficient funds');
  }

  const { rows } = await client.query(
    `INSERT INTO transactions (reference, kind, description)
     VALUES ($1, $2, $3) RETURNING id, reference, kind, description, created_at`,
    [p.reference, p.kind, p.description ?? null],
  );
  const tx = rows[0];

  // Two balanced legs: debit the sender, credit the receiver.
  await client.query(
    `INSERT INTO entries (transaction_id, account_id, amount) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [tx.id, p.fromId, -p.amount, p.toId, p.amount],
  );

  return { ...tx, from: p.fromId, to: p.toId, amount: p.amount, currency: from.currency };
}

export async function transfer(input: Omit<PostingInput, 'kind'>) {
  if (input.fromId === input.toId) {
    throw new LedgerError(422, 'same_account', 'Cannot transfer to the same account');
  }
  return withTransaction((client) => post(client, { ...input, kind: 'transfer' }));
}

/**
 * Credit a user account from the external funding source (e.g. a Paystack charge).
 * Returns null if this reference was already processed — webhooks get retried.
 */
export async function deposit(accountId: string, amount: number, reference: string) {
  try {
    return await withTransaction((client) =>
      post(client, {
        reference,
        kind: 'deposit',
        description: 'Card funding via Paystack',
        fromId: FUNDING_ACCOUNT_ID,
        toId: accountId,
        amount,
      }),
    );
  } catch (err: any) {
    if (err?.code === '23505') return null; // unique violation on reference → duplicate event
    throw err;
  }
}

/** Sanity check used by tests and /health: the whole ledger must sum to zero. */
export async function trialBalance(): Promise<number> {
  const { rows } = await pool.query('SELECT COALESCE(SUM(amount), 0)::BIGINT AS total FROM entries');
  return rows[0].total;
}
