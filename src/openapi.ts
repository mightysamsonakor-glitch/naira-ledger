const errorRef = { $ref: '#/components/schemas/Error' };

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Naira Ledger API',
    version: '1.0.0',
    description:
      'Double-entry wallet ledger. All amounts are integers in kobo (1 NGN = 100 kobo). ' +
      'POST /transfers requires an `Idempotency-Key` header.',
  },
  components: {
    schemas: {
      Error: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      Account: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          currency: { type: 'string', example: 'NGN' },
          kind: { type: 'string', enum: ['user', 'system'] },
          balance: { type: 'integer', description: 'kobo' },
          created_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
  paths: {
    '/health': { get: { summary: 'Health and trial balance (must be 0)', responses: { 200: { description: 'OK' } } } },
    '/accounts': {
      post: {
        summary: 'Open an account',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: { name: { type: 'string', example: 'Ada' }, currency: { type: 'string', example: 'NGN' } },
              },
            },
          },
        },
        responses: { 201: { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } } },
      },
    },
    '/accounts/{id}': {
      get: {
        summary: 'Get account with derived balance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Account' } } } },
          404: { description: 'Not found', content: { 'application/json': { schema: errorRef } } },
        },
      },
    },
    '/accounts/{id}/transactions': {
      get: {
        summary: 'Account statement (newest first)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/transfers': {
      post: {
        summary: 'Move money between accounts',
        parameters: [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }],
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['from', 'to', 'amount'],
                properties: {
                  from: { type: 'string', format: 'uuid' },
                  to: { type: 'string', format: 'uuid' },
                  amount: { type: 'integer', example: 250000, description: 'kobo' },
                  description: { type: 'string' },
                },
              },
            },
          },
        },
        responses: {
          201: { description: 'Transfer posted' },
          409: { description: 'Idempotency key reused with a different body', content: { 'application/json': { schema: errorRef } } },
          422: { description: 'Insufficient funds / currency mismatch', content: { 'application/json': { schema: errorRef } } },
        },
      },
    },
    '/webhooks/paystack': {
      post: {
        summary: 'Paystack-style charge.success webhook (HMAC-SHA512 signed)',
        parameters: [{ name: 'x-paystack-signature', in: 'header', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Acknowledged' }, 401: { description: 'Bad signature' } },
      },
    },
  },
};
