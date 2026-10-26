import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrateSyntheticDatabase } from '../db/migrate';
import { previewSquareSandboxCatalog, type SquareCatalogPreview } from '../server/src/square-catalog-readonly';
import { initializeEmptyMerchantCatalog, MerchantCatalogImportStore, MerchantImportError,
  reviewedMerchantImportPlan, type MerchantCatalogIdentity } from '../server/src/merchant-catalog-import';
import { createSquareMerchantImportAdministration } from '../server/src/merchant-import-service';

const seller: MerchantCatalogIdentity = { squareMerchantId: 'SANDBOXMERCHANT', squareLocationId: 'SANDBOXLOCATION' };
const config = { environment: 'sandbox' as const, token: 'synthetic-test-access-token', locationId: seller.squareLocationId };
const apiObject = (itemId: string, sku: string, options: { taxed?: boolean; price?: number; stock?: number } = {}) => ({
  type: 'ITEM', id: itemId, present_at_all_locations: true,
  item_data: {
    name: 'Merchant item ' + itemId, description: 'Sample food or retail product', category_id: 'CAT1',
    ...(options.taxed ? { tax_ids: ['TAX1'] } : {}),
    variations: [{
      id: 'VAR_' + itemId, type: 'ITEM_VARIATION', present_at_all_locations: true,
      item_variation_data: { name: 'Regular', sku, pricing_type: 'FIXED_PRICING',
        price_money: { amount: options.price ?? 1950, currency: 'USD' },
        track_inventory: options.stock !== undefined },
    }],
  },
});
async function squarePreview(objects: unknown[]): Promise<SquareCatalogPreview> {
  return previewSquareSandboxCatalog(config, async () => new Response(JSON.stringify({ objects }), { status: 200 }));
}
async function newMerchantDb() {
  const db = await PGlite.create();
  await initializeEmptyMerchantCatalog(db, seller);
  return db;
}
const rejected = (code: MerchantImportError['code']) =>
  (error: unknown) => error instanceof MerchantImportError && error.code === code;

test('server-only commerce opt-in imports taxed items with stable mappings but leaves checkout and stock disabled', async () => {
  const db = await newMerchantDb();
  const objects = [apiObject('TAXED', 'SKU-TAXED', { taxed: true })];
  const options = { taxTreatment: 'square-order-authoritative' as const };
  try {
    const preview = await previewSquareSandboxCatalog(config, async () => new Response(JSON.stringify({ objects })), options);
    assert.throws(() => reviewedMerchantImportPlan(preview, seller, 'square'), rejected('PREVIEW_INVALID'));
    const plan = reviewedMerchantImportPlan(preview, seller, 'square', options);
    assert.equal(plan.plan.taxTreatment, 'square-order-authoritative');
    assert.equal(plan.plan.sourceLinks[0]!.variants[0]!.squareVariationId, 'VAR_TAXED');
    const settings = { STARTER_DATASET: 'merchant-catalog-v1', SQUARE_ENVIRONMENT: 'sandbox',
      SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test', SQUARE_LOCATION_ID: seller.squareLocationId,
      SQUARE_SANDBOX_MERCHANT_ID: seller.squareMerchantId, SQUARE_SANDBOX_ACCESS_TOKEN: config.token,
      SQUARE_SANDBOX_REQUESTS_ENABLED: 'true' };
    const fetcher: typeof fetch = async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/merchants') return new Response(JSON.stringify({ merchant: [{ id: seller.squareMerchantId }] }));
      if (path === '/v2/locations') return new Response(JSON.stringify({ locations: [{ id: seller.squareLocationId, merchant_id: seller.squareMerchantId }] }));
      assert.equal(path, '/v2/catalog/list');
      return new Response(JSON.stringify({ objects }));
    };
    const ordinary = createSquareMerchantImportAdministration(db, settings, fetcher);
    await assert.rejects(ordinary.stage('square'), rejected('NO_ELIGIBLE_PRODUCTS'));
    for (const invalid of [{ STARTER_DATASET: 'synthetic-retail-v1' }, { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_SANDBOX_REQUESTS_ENABLED: 'false' }]) {
      assert.throws(() => createSquareMerchantImportAdministration(db, { ...settings, SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', ...invalid }, fetcher), /IMPORT_CONFIGURATION/);
    }
    const service = createSquareMerchantImportAdministration(db, { ...settings, SQUARE_MERCHANT_COMMERCE_ENABLED: 'true' }, fetcher);
    const staged = await service.stage('square');
    assert.equal(staged.productCount, 1);
    assert.equal(staged.reviewHolds, 0);
    assert.equal(staged.fingerprint, plan.fingerprint);
    const committed = await service.commit(staged.fingerprint, 'operator', 'approve-disabled-merchant-import-v1');
    assert.equal(committed.checkoutEnabled, false);
    assert.deepEqual((await db.query('SELECT enabled,stock_quantity FROM catalog_variants')).rows, [{ enabled: false, stock_quantity: 0 }]);
    assert.deepEqual((await db.query('SELECT checkout_enabled FROM merchant_catalog_identity')).rows, [{ checkout_enabled: false }]);
    assert.deepEqual((await db.query('SELECT square_variation_id FROM merchant_square_variation_links')).rows, [{ square_variation_id: 'VAR_TAXED' }]);
    assert.equal((await service.commit(staged.fingerprint, 'operator', 'approve-disabled-merchant-import-v1')).reused, true);
  } finally { await db.close(); }
});

test('merchant initialization is a separate empty database; existing synthetic database is never adopted or modified', async () => {
  const synthetic = await PGlite.create();
  try {
    await migrateSyntheticDatabase(synthetic);
    const before = (await synthetic.query('SELECT id,stock_quantity,enabled FROM catalog_variants ORDER BY id')).rows;
    await assert.rejects(initializeEmptyMerchantCatalog(synthetic, seller), rejected('NOT_EMPTY'));
    const preview = await squarePreview([apiObject('ITEM1','merchant-SKU1')]);
    await assert.rejects(new MerchantCatalogImportStore(synthetic).stage(preview, seller, 'square'),
      rejected('TARGET_UNVERIFIED'));
    assert.deepEqual((await synthetic.query('SELECT id,stock_quantity,enabled FROM catalog_variants ORDER BY id')).rows, before);
    assert.deepEqual((await synthetic.query("SELECT dataset FROM demo_database_state WHERE singleton=true")).rows, [{ dataset: 'synthetic-retail-v1' }]);
  } finally { await synthetic.close(); }
  const db = await newMerchantDb();
  try {
    await assert.rejects(initializeEmptyMerchantCatalog(db, seller), rejected('NOT_EMPTY'));
    const marker = (await db.query('SELECT dataset,inventory_owner,checkout_enabled FROM merchant_catalog_identity WHERE singleton=true')).rows[0] as Record<string,unknown>;
    assert.deepEqual(marker, { dataset: 'merchant-catalog-v1', inventory_owner: 'unassigned', checkout_enabled: false });
    const tables = (await db.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows.map(x => x.table_name);
    for (const forbidden of ['demo_database_state','checkout_attempts','sandbox_checkout_attempts','mock_payment_ledger']) assert.equal(tables.includes(forbidden), false);
  } finally { await db.close(); }
});

test('stage is read-only on products; commit imports disabled zero-stock variants once and preserves stable Square mapping', async () => {
  const db = await newMerchantDb();
  try {
    const preview = await squarePreview([
      { type: 'CATEGORY', id: 'CAT1', category_data: { name: 'Retail' } },
      apiObject('ITEM_A','SELLER-SKU-A'),
      apiObject('ITEM_B','SELLER-SKU-B', { price: 990 }),
      apiObject('ITEM_TAXED','SELLER-SKU-T', { taxed: true }),
    ]);
    const store = new MerchantCatalogImportStore(db);
    const staged = await store.stage(preview, seller, 'square');
    assert.equal(staged.state, 'staged');
    assert.equal(staged.reused, false);
    assert.equal(staged.productCount, 2);
    assert.equal(staged.variantCount, 2);
    assert.equal(staged.reviewHolds, 1);
    assert.equal(staged.checkoutEnabled, false);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_variants')).rows[0]?.count, 0);
    const repeated = await store.stage(preview, seller, 'square');
    assert.equal(repeated.fingerprint, staged.fingerprint);
    assert.equal(repeated.reused, true);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM merchant_catalog_import_batches')).rows[0]?.count, 1);
    await assert.rejects(store.commit(staged.fingerprint, seller, 'operator1', '' as never), rejected('REVIEW_REQUIRED'));
    await assert.rejects(store.commit('0'.repeat(64), seller, 'operator1', 'approve-disabled-merchant-import-v1'), rejected('STAGE_NOT_FOUND'));
    const committed = await store.commit(staged.fingerprint, seller, 'operator1', 'approve-disabled-merchant-import-v1');
    assert.equal(committed.state, 'committed');
    assert.equal(committed.reused, false);
    assert.deepEqual((await db.query<{ sku: string; price_minor: number; enabled: boolean; stock_quantity: number }>(
      'SELECT sku,price_minor,enabled,stock_quantity FROM catalog_variants ORDER BY sku')).rows,
      [
        { sku: 'SELLER-SKU-A', price_minor: 1950, enabled: false, stock_quantity: 0 },
        { sku: 'SELLER-SKU-B', price_minor: 990, enabled: false, stock_quantity: 0 },
      ]);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM merchant_square_item_links')).rows[0]?.count, 2);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM merchant_square_variation_links')).rows[0]?.count, 2);
    assert.deepEqual((await db.query('SELECT inventory_owner,checkout_enabled FROM merchant_catalog_identity')).rows, [
      { inventory_owner: 'square', checkout_enabled: false },
    ]);
    assert.deepEqual((await db.query('SELECT committed_by,state FROM merchant_catalog_import_batches')).rows,
      [{ committed_by: 'operator1', state: 'committed' }]);
    const replay = await store.commit(staged.fingerprint, seller, 'operator2', 'approve-disabled-merchant-import-v1');
    assert.equal(replay.reused, true);
    assert.deepEqual((await db.query('SELECT committed_by FROM merchant_catalog_import_batches')).rows, [{ committed_by: 'operator1' }]);
    const changed = await squarePreview([apiObject('ITEM_NEW','SELLER-SKU-N')]);
    const newer = await store.stage(changed, seller, 'square');
    assert.equal(newer.state, 'staged');
    await assert.rejects(store.commit(newer.fingerprint, seller, 'operator1', 'approve-disabled-merchant-import-v1'), rejected('IMPORT_CONFLICT'));
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_products')).rows[0]?.count, 2);
  } finally { await db.close(); }
});

test('preview tampering, wrong seller/location, reselected authority and missing inventory are rejected before product writes', async () => {
  const db = await newMerchantDb();
  try {
    const preview = await squarePreview([apiObject('ITEM_A','SELLER-SKU-A', { stock: 9 })]);
    const store = new MerchantCatalogImportStore(db);
    await assert.rejects(store.stage(preview, { ...seller, squareMerchantId: 'WRONG' }, 'square'), rejected('TARGET_UNVERIFIED'));
    await assert.rejects(store.stage(preview, { ...seller, squareLocationId: 'WRONG' }, 'website'), rejected('TARGET_UNVERIFIED'));
    await assert.rejects(store.stage(await squarePreview([]), seller, 'square'), rejected('NO_ELIGIBLE_PRODUCTS'));
    const changedMoney = structuredClone(preview);
    (changedMoney.draft.products[0]!.variants[0] as { priceMinor: number }).priceMinor = 1;
    await assert.rejects(store.stage(changedMoney, seller, 'square'), rejected('PREVIEW_INVALID'));
    const changedStock = structuredClone(preview);
    (changedStock.draft.products[0]!.variants[0] as { stockQuantity: number }).stockQuantity = 50;
    await assert.rejects(store.stage(changedStock, seller, 'square'), rejected('PREVIEW_INVALID'));
    const changedFlags = structuredClone(preview);
    (changedFlags.draft.products[0]!.variants[0] as { enabled: boolean }).enabled = true;
    await assert.rejects(store.stage(changedFlags, seller, 'square'), rejected('PREVIEW_INVALID'));
    const staged = await store.stage(preview, seller, 'website');
    assert.equal(staged.inventoryOwner,'website');
    const approved = await store.commit(staged.fingerprint, seller, 'reviewer22', 'approve-disabled-merchant-import-v1');
    assert.equal(approved.inventoryOwner,'website');
    await assert.rejects(store.stage(preview, seller, 'square'), rejected('IMPORT_CONFLICT'));
    const variant = (await db.query('SELECT enabled,stock_quantity FROM catalog_variants')).rows[0] as Record<string,unknown>;
    assert.deepEqual(variant, { enabled: false, stock_quantity: 0 });
    assert.equal((await db.query<{ checkout_enabled: boolean }>('SELECT checkout_enabled FROM merchant_catalog_identity')).rows[0]?.checkout_enabled, false);
  } finally { await db.close(); }
});

test('conflicting preexisting rows make the approved transaction fail without partial product writes', async () => {
  const db = await newMerchantDb();
  try {
    const preview = await squarePreview([apiObject('ITEM_A','SELLER-SKU-A'),apiObject('ITEM_B','SELLER-SKU-B')]);
    const store = new MerchantCatalogImportStore(db);
    const stage = await store.stage(preview, seller, 'square');
    await db.query("INSERT INTO catalog_products(id,name,description,category,options) VALUES ('someone-elses-product','Conflicting product','Do not overwrite','Other','[]'::jsonb)");
    await assert.rejects(store.commit(stage.fingerprint, seller, 'reviewer1', 'approve-disabled-merchant-import-v1'), rejected('IMPORT_CONFLICT'));
    assert.deepEqual((await db.query('SELECT id FROM catalog_products')).rows, [{ id:'someone-elses-product' }]);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_variants')).rows[0]?.count, 0);
    assert.equal((await db.query<{ inventory_owner: string }>('SELECT inventory_owner FROM merchant_catalog_identity')).rows[0]?.inventory_owner, 'unassigned');
    assert.equal((await db.query<{ state: string }>('SELECT state FROM merchant_catalog_import_batches')).rows[0]?.state, 'staged');
  } finally { await db.close(); }
});

test('stable source mapping and fingerprints do not change with reordered JSON properties; held Square items stay out', async () => {
  const preview = await squarePreview([apiObject('ITEM_A','SELLER-SKU-A'), apiObject('ITEM_B','SELLER-SKU-B', {taxed:true})]);
  const a = reviewedMerchantImportPlan(preview, seller, 'square');
  const b = reviewedMerchantImportPlan(structuredClone(preview), seller, 'square');
  assert.equal(a.fingerprint, b.fingerprint);
  assert.equal(a.plan.sourceLinks.length, 1);
  assert.equal(a.plan.catalog.products.length, 1);
  assert.equal(a.plan.reviewHolds, 1);
  assert.equal(a.plan.catalog.products[0]!.variants[0]!.enabled, false);
  assert.equal(a.plan.catalog.products[0]!.variants[0]!.stockQuantity, 0);
  assert.notEqual(reviewedMerchantImportPlan(preview,seller,'website').fingerprint,a.fingerprint);
});

