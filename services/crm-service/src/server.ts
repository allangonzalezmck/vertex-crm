/**
 * @file services/crm-service/src/server.ts
 * @description Process entry point. Builds the Fastify app and listens.
 */

import { buildApp } from './app.js';

const PORT = parseInt(process.env['PORT'] ?? '8080', 10);

async function main(): Promise<void> {
  try {
    const app = await buildApp();
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    console.error('Failed to start crm-service', err);
    process.exit(1);
  }
}

void main();
