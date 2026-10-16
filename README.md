# Naira Ledger

![CI](https://github.com/mightysamsonakor-glitch/naira-ledger/actions/workflows/ci.yml/badge.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)

A wallet and payment ledger API, built the way fintechs build them: **double-entry bookkeeping**, **idempotent payments**, and **signed Paystack-style webhooks**. It's small enough to read in one sitting, but it handles the failure cases that matter with real money.

> Built by [Mighty Samson Akor](https://github.com/mightysamsonakor-glitch), also the creator of [GlobalRate](https://www.globalrate.space).

## What it guarantees

| Problem | How it's handled | Proven by test |
|---|---|---|
| Money appearing or disappearing | Every transaction is ≥2 entries that **must sum to zero**, enforced by a Postgres constraint trigger at `COMMIT` | `refuses unbalanced entries at commit time` |
| A user taps "Send" twice / client retries after timeout | `Idempotency-Key` header; retries replay the stored response, no second debit | `replays the stored response…`, `handles simultaneous duplicate requests…` |
| Two transfers race and overspend | Row locks (`SELECT … FOR UPDATE`) on accounts before checking balance | `never overspends under concurrent load` (20 parallel requests) |
| A→B and B→A deadlocking | Accounts always locked in sorted order | `does not deadlock on opposite-direction transfers` |
| Forged or replayed webhooks | HMAC-SHA512 signature check (timing-safe) + unique reference | `rejects a bad signature`, `ignores duplicate deliveries…` |
| Silent edits to history | Entries table is append-only (trigger blocks UPDATE/DELETE) | `refuses edits to posted entries` |
| Floating-point rounding errors | All amounts are integers in **kobo** (`BIGINT`) | — |

Balances are never stored. They're always derived from the entries, so the books can be audited at any time. `GET /health` returns the trial balance, which must always be `0`.

## Architecture

```
            ┌──────────────┐      charge.success (signed)
 Paystack ─▶│  /webhooks   │──┐
            └──────────────┘  │
            ┌──────────────┐  │   ┌───────────────────┐    ┌──────────────────────┐
 Client  ─▶ │ /transfers   │──┼──▶│ ledger.ts         │──▶ │ PostgreSQL           │
  (Idempotency-Key)         │   │  lock → check →   │    │  accounts            │
            └──────────────┘  │   │  post 2 entries   │    │  transactions        │
            ┌──────────────┐  │   └───────────────────┘    │  entries (Σ = 0)     │
            │ /accounts    │──┘                            │  idempotency_keys    │
            └──────────────┘                               └──────────────────────┘
```

## Run it

**With Docker (one command):**

```bash
docker compose up --build
# API:  http://localhost:3000
# Docs: http://localhost:3000/docs
```

**Locally (Node 20+ and Postgres):**

```bash
cp .env.example .env
docker compose up -d db      # or point DATABASE_URL at your own Postgres
npm install
npm run dev
```

**Tests** (need a running Postgres; CI provides one automatically):

```bash
npm test
```

## Try it

```bash
# 1. Open two accounts
curl -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"name":"Ada"}'
curl -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"name":"Tunde"}'

# 2. Fund Ada through a signed Paystack-style webhook (₦5,000 = 500000 kobo)
BODY='{"event":"charge.success","data":{"reference":"ref_123","amount":500000,"metadata":{"account_id":"<ADA_ID>"}}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac sk_test_local_secret | awk '{print $2}')
curl -X POST localhost:3000/webhooks/paystack -H 'content-type: application/json' \
     -H "x-paystack-signature: $SIG" -d "$BODY"

# 3. Send ₦1,500 to Tunde. Run this twice: the second call is a replay, not a second payment.
curl -X POST localhost:3000/transfers -H 'content-type: application/json' \
     -H 'Idempotency-Key: order-42' \
     -d '{"from":"<ADA_ID>","to":"<TUNDE_ID>","amount":150000}'

# 4. Check balance and statement
curl localhost:3000/accounts/<ADA_ID>
curl localhost:3000/accounts/<ADA_ID>/transactions
```

## API

| Method | Path | Description |
|---|---|---|
| `POST` | `/accounts` | Open an account (`name`, optional `currency`, default `NGN`) |
| `GET` | `/accounts/:id` | Account with derived balance |
| `GET` | `/accounts/:id/transactions` | Statement, newest first |
| `POST` | `/transfers` | Move money. Requires `Idempotency-Key` |
| `POST` | `/webhooks/paystack` | Credit an account on `charge.success` |
| `GET` | `/health` | Status + trial balance |
| `GET` | `/docs` | Swagger UI |

Error responses look like `{ "error": "insufficient_funds", "message": "…" }`, with codes `400` validation, `401` bad signature, `404` not found, `409` idempotency conflict, `422` business rule.

## Tech

TypeScript (strict) · Node.js · Express 5 · PostgreSQL 16 · Zod · Vitest + Supertest · Docker · GitHub Actions

## Design notes

- **Why derive balances instead of storing them?** A stored balance can drift from the transaction history; a derived one can't. At scale you'd add a cached balance column updated in the same DB transaction, with the entries remaining the source of truth.
- **Why does an in-flight duplicate get `409` instead of waiting?** It keeps no DB connection held across the request (the same behaviour as Stripe). Clients simply retry and receive the stored result.
- **Next steps:** pagination cursors on statements, JWT auth per account owner, multi-currency transfers using live FX rates, and outbound payouts (Paystack Transfers).

## License

MIT
