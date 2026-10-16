import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:5432/ledger',
  webhookSecret: process.env.PAYSTACK_SECRET ?? 'sk_test_local_secret',
};

export const FUNDING_ACCOUNT_ID = '00000000-0000-0000-0000-000000000001';
