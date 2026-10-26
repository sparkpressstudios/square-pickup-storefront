import { openLocalDemoDatabase } from './local-database';

const local = await openLocalDemoDatabase();
try {
  const catalog = await local.checkout.getCatalog();
  console.log(`Isolated embedded PostgreSQL ready: ${local.dataDir}`);
  console.log(`Synthetic products: ${catalog.products.length}; no database port, credentials, cloud service, or Square calls.`);
} finally { await local.close(); }
