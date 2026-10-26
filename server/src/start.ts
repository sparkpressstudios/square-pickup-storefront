import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from './app';
import { PostgresAdminCatalog } from './admin-catalog';
import { PostgresMerchantSettings } from './merchant-settings';
import { merchant } from '../../config/merchant';
import { SandboxReconciliationQueue } from './reconciliation-jobs';
import { runtimeSettings } from './runtime-settings';
import { DurableCheckoutService, PostgresCheckoutStore } from './durable-checkout';
import { createRuntimeSandbox } from './square-runtime';

// Default remains isolated memory. Native networking/database and sandbox calls require explicit settings.
const settings = runtimeSettings(process.env, process.argv.includes('--railway'));
const directory = resolve('dist/client');
if (process.argv.includes('--built') && !existsSync(resolve(directory, 'index.html'))) throw new Error('Run pnpm build first');
const database = settings.native ? await (await import('../../db/native-database')).openNativeSyntheticDatabase(process.env) : process.argv.includes('--local-db') ? await (await import('../../db/local-database')).openLocalDemoDatabase() : null;
const checkout = database ? new DurableCheckoutService(new PostgresCheckoutStore(database.db)) : undefined;
let sandbox: ReturnType<typeof createRuntimeSandbox> | undefined;
const app = await (async () => { try {
  if (settings.sandbox && (!database || !settings.origin)) throw new Error('Sandbox activation requires explicit durable storage and HTTPS origin');
  sandbox = settings.sandbox ? createRuntimeSandbox(database!.db, process.env, settings.origin!) : undefined;
  return await createApp(checkout ? { load: () => checkout.getCatalog() } : undefined, { checkout, localDatabase: Boolean(database && !settings.native), storage: settings.native ? 'native-postgres' : undefined, origin: settings.origin, sandbox,
  healthcheck: database ? async () => { await database.db.query('SELECT 1'); } : undefined,
  admin: database ? { store: new PostgresAdminCatalog(database.db), settings: new PostgresMerchantSettings(database.db, merchant), reconciliation: new SandboxReconciliationQueue(database.db) } : undefined });
} catch (error) { await database?.close(); throw error; } })();
const server = createServer(app);
if (process.argv.includes('--built')) {
  app.use(express.static(directory));
  app.get(['/admin', '/admin/login', '/admin/products', '/admin/products/:id', '/admin/integration', '/admin/import', '/admin/square-services', '/admin/settings', '/admin/preview', '/admin/preview/products', '/admin/preview/products/:id', '/admin/preview/integration', '/admin/preview/import', '/admin/preview/square-services', '/admin/preview/settings'], (_req, res) => res.sendFile(resolve(directory, 'index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
  app.use(vite.middlewares);
  server.once('close', () => { void vite.close(); });
}
server.listen(settings.port, settings.host, () => console.log(`Starter listening on ${settings.host}:${settings.port}; production payments, mail and schedulers disabled; sandbox ${sandbox ? 'explicitly configured, acceptance unverified' : 'disabled'}`));
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await database?.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
