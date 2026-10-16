import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { pool } from './db.js';

/**
 * Idempotency-Key middleware (the same pattern Stripe and Paystack use).
 *
 * - First request with a key: claims the key, runs the handler, stores the response.
 * - Retry with the same key + same body: replays the stored response; no money moves.
 * - Same key while the first is still running: 409 request_in_progress.
 * - Same key with a different body: 409 idempotency_key_reused.
 *
 * The claim is a single INSERT ... ON CONFLICT DO NOTHING, so two simultaneous
 * requests can never both win, and no DB connection is held across the handler.
 */
export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.header('Idempotency-Key');
    if (!key || key.length > 255) {
      return res
        .status(400)
        .json({ error: 'missing_idempotency_key', message: 'An Idempotency-Key header (max 255 chars) is required' });
    }

    const requestHash = createHash('sha256')
      .update(req.method + req.path + JSON.stringify(req.body ?? {}))
      .digest('hex');

    const claim = await pool.query(
      `INSERT INTO idempotency_keys (key, request_hash) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING RETURNING key`,
      [key, requestHash],
    );

    if (!claim.rowCount) {
      const { rows } = await pool.query(
        'SELECT request_hash, status_code, response FROM idempotency_keys WHERE key = $1',
        [key],
      );
      const saved = rows[0];
      if (saved.request_hash !== requestHash) {
        return res.status(409).json({ error: 'idempotency_key_reused', message: 'Key was used with a different request' });
      }
      if (saved.status_code === null) {
        return res.status(409).json({ error: 'request_in_progress', message: 'A request with this key is still processing' });
      }
      res.setHeader('Idempotent-Replay', 'true');
      return res.status(saved.status_code).json(saved.response);
    }

    // We own the key. Store the final response before it is sent.
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const store =
        res.statusCode >= 500
          ? // Server errors stay retryable: release the key.
            pool.query('DELETE FROM idempotency_keys WHERE key = $1', [key])
          : pool.query('UPDATE idempotency_keys SET status_code = $2, response = $3 WHERE key = $1', [
              key,
              res.statusCode,
              JSON.stringify(body),
            ]);
      store
        .catch((err) => console.error('idempotency store failed', err))
        .finally(() => originalJson(body));
      return res;
    };
    next();
  };
}
