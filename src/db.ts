import pg from 'pg';
import { config } from './config.js';

// BIGINT comes back as a string by default; our amounts fit safely in a JS number
// (Number.MAX_SAFE_INTEGER kobo is ~90 trillion naira).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

/** Run `fn` inside a single database transaction, rolling back on any error. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
