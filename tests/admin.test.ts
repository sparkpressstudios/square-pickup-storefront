import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PGlite } from '@electric-sql/pglite';
import { demoCatalog } from '../config/demo-catalog';
import { AdminError, parseProductEdit, type EditableProduct, type ProductEditRequest } from '../shared/admin-catalog';
import { activeAdminHref, catalogSummary, filterProducts, formRequest, priceMinor, productForm } from '../client/src/admin-model';
import { AdminDashboard, AdminLayout, AdminProductEdit, AdminProductList } from '../client/src/admin';
import { PostgresAdminCatalog, productRevision, type StaffPrincipal } from '../server/src/admin-catalog';
import { createApp } from '../server/src/app';
import { migrateSyntheticDatabase } from '../db/migrate';
import { DurableCheckoutService, PostgresCheckoutStore } from '../server/src/durable-checkout';

function edit(product = demoCatalog.products[0]!): ProductEditRequest {
  return formRequest(productForm(product), productRevision(product));
}
test('adapted navigation chooses the longest valid path, with an exact dashboard root', () => {
  const hrefs = ['/admin', '/admin/products', '/admin/products/special'];
  assert.equal(activeAdminHref('/admin', hrefs, '/admin'), '/admin');
  assert.equal(activeAdminHref('/admin/products/studio-candle', hrefs, '/admin'), '/admin/products');
  assert.equal(activeAdminHref('/admin/products/special/edit', hrefs, '/admin'), '/admin/products/special');
  assert.equal(activeAdminHref('/admin/products-other', hrefs, '/admin'), undefined);
  assert.equal(activeAdminHref('/admin/unknown', hrefs, '/admin'), undefined);
});
test('product search and dashboard count food and non-food through the same generic catalog', () => {
  assert.equal(filterProducts(demoCatalog.products, 'CANDLE')[0]!.id, 'studio-candle');
  assert.equal(filterProducts(demoCatalog.products, 'granola')[0]!.id, 'pantry-granola');
  assert.equal(filterProducts(demoCatalog.products, 'missing').length, 0);
  assert.deepEqual(catalogSummary(demoCatalog.products), { products: 4, variants: 9, available: 7, soldOut: 1 });
});
test('editor parses exact USD decimals and whole stock; refuses truncation and overflow', () => {
  assert.equal(priceMinor('0.01'), 1); assert.equal(priceMinor('12.3'), 1230); assert.equal(priceMinor('21474836.47'), 2_147_483_647);
  for (const value of ['1.005', '1e2', '-1', '+1', 'NaN', 'Infinity', ' 1', '01', '1.', '21474836.48']) assert.throws(() => priceMinor(value));
  const form = productForm(demoCatalog.products[0]!);
  for (const stock of ['1.5', '-1', '1e2', '2foo', '2147483648']) assert.throws(() => formRequest({ ...form, variants: form.variants.map((variant) => ({ ...variant, stock })) }, '0'.repeat(64)));
  assert.deepEqual(edit().variants.map((variant) => variant.priceMinor), demoCatalog.products[0]!.variants.map((variant) => variant.priceMinor));
});
test('adapted admin views render neutral fields, options, preview boundary and escaped descriptions', () => {
  const navigate = () => {};
  const root = '/admin/preview';
  const list = renderToStaticMarkup(createElement(AdminProductList, { products: demoCatalog.products, root, navigate }));
  assert.match(list, /Studio candle/); assert.match(list, /Pantry granola/); assert.match(list, /Variants/);
  const dashboard = renderToStaticMarkup(createElement(AdminDashboard, { products: demoCatalog.products, root, navigate }));
  assert.match(dashboard, /automatic Square POS inventory synchronization is not implemented/);
  const product = { ...demoCatalog.products[0]!, description: '<script>alert(1)</script>' };
  const editor = renderToStaticMarkup(createElement(AdminProductEdit, { entry: { product, revision: productRevision(product) }, preview: true, onSave: async () => {}, onReload: () => {}, root, navigate }));
  assert.match(editor, /Scent: Cedar \/ Vessel: Amber/); assert.match(editor, /Save draft/); assert.match(editor, /&lt;script&gt;/); assert.doesNotMatch(editor, /<script/);
  const shell = renderToStaticMarkup(createElement(AdminLayout, { path: `${root}/products/studio-candle`, root, navigate, preview: true, children: 'Editor' }));
  assert.match(shell, /Changes stay in this tab/); assert.match(shell, /aria-current="page">Products/);
  assert.doesNotMatch(shell + editor, /Urban Churn|admin_token|login-bg|ice_cream|cake/);
});
test('staff APIs default closed, ignoring forged role headers and request bodies', async (t) => {
  const app = await createApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const method of ['GET', 'PUT']) {
    const response = await fetch(`${origin}/api/admin/products/studio-candle`, { method, headers: { 'X-Role': 'admin', Authorization: 'Bearer fabricated', 'Content-Type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ role: 'admin' }) } : {}) });
    assert.equal(response.status, 401); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await fetch(`${origin}/api/admin/session`)).status, 401);
});
test('isolated catalog edits enforce staff/CSRF boundaries, atomic validation and checkout-aware stale revisions', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-admin-synthetic-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
  const store = new PostgresAdminCatalog(db); const checkoutStore = new PostgresCheckoutStore(db); const checkout = new DurableCheckoutService(checkoutStore);
  let principal: StaffPrincipal | null = null;
  const csrfToken = 'synthetic-csrf-token-only-for-tests';
  const app = await createApp({ load: () => store.load() }, { localDatabase: true, checkout, admin: { store, verifyStaff: async () => principal } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await db.close(); });
  async function product(id = 'studio-candle') { return (await store.load()).products.find((item) => item.id === id)!; }
  const put = (request: unknown, id = 'studio-candle', extra: Record<string, string> = {}) => fetch(`${origin}/api/admin/products/${id}`, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...extra }, body: JSON.stringify(request) });
  await t.test('null/staff identities cannot manage catalogs; admin and manager are explicit roles', async () => {
    assert.equal((await put(edit())).status, 401);
    principal = { id: 'synthetic-staff', role: 'staff', csrfToken };
    assert.equal((await put(edit())).status, 403); assert.equal((await fetch(`${origin}/api/admin/products`)).status, 403);
    principal = { id: 'synthetic-admin', role: 'admin', csrfToken };
    const session = await (await fetch(`${origin}/api/admin/session`)).json(); assert.equal(session.role, 'admin'); assert.equal(session.catalogEditing, true);
    const response = await fetch(`${origin}/api/admin/products`); assert.equal(response.status, 200); assert.equal((await response.json()).products.length, 4);
  });
  await t.test('wrong/missing CSRF or foreign/missing origin cannot mutate even with a verified administrator', async () => {
    const before = await product();
    const deniedHeaders: Record<string, string>[] = [{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong-token' }, { Origin: 'https://another.example' }, { Origin: '' }];
    for (const headers of deniedHeaders) assert.equal((await put(edit(before), before.id, headers)).status, 403);
    assert.deepEqual(await product(), before);
  });
  await t.test('strict field whitelist rejects invalid quantities/prices, forged identities/options and unknown fields atomically', async () => {
    const before = await product(); const valid = edit(before);
    const invalid = [
      { ...valid, role: 'admin' }, { ...valid, name: '' }, { ...valid, description: 'x'.repeat(2001) }, { ...valid, category: 'bad\ncategory' },
      { ...valid, variants: [] }, { ...valid, variants: [valid.variants[0], valid.variants[0]] },
      { ...valid, variants: valid.variants.map((variant) => ({ ...variant, priceMinor: 1.5 })) },
      { ...valid, variants: valid.variants.map((variant) => ({ ...variant, stockQuantity: -1 })) },
      { ...valid, variants: valid.variants.map((variant) => ({ ...variant, enabled: 'yes' })) },
      { ...valid, variants: valid.variants.map((variant) => ({ ...variant, sku: 'changed' })) },
      { ...valid, variants: valid.variants.map((variant) => ({ ...variant, id: 'unknown-variant' })) },
      { ...valid, variants: valid.variants.slice(1) },
    ];
    for (const input of invalid) assert.equal((await put(input)).status, 400);
    assert.deepEqual(await product(), before);
    assert.equal((await put(valid, 'unknown-product')).status, 404);
    assert.throws(() => parseProductEdit(null), AdminError);
  });
  await t.test('food/non-food product updates preserve IDs/options/SKUs and appear in server-authoritative storefront/quotes', async () => {
    for (const id of ['studio-candle', 'pantry-granola']) {
      const before = await product(id); const request = { ...edit(before), name: `${before.name} revised`, variants: edit(before).variants.map((variant) => ({ ...variant, priceMinor: variant.priceMinor + 25 })) };
      principal = { id: 'synthetic-manager', role: 'manager', csrfToken };
      const response = await put(request, id); assert.equal(response.status, 200);
      const saved = await response.json() as EditableProduct; assert.equal(saved.product.name, request.name); assert.notEqual(saved.revision, request.revision);
      assert.deepEqual(saved.product.options, before.options); assert.deepEqual(saved.product.variants.map((variant) => [variant.id, variant.sku, variant.selections]), before.variants.map((variant) => [variant.id, variant.sku, variant.selections]));
      const storefront = await (await fetch(`${origin}/api/storefront`)).json(); assert.equal(storefront.catalog.products.find((item: { id: string }) => item.id === id).name, request.name);
      const variant = saved.product.variants.find((item) => item.enabled && item.stockQuantity > 0)!;
      const quote = await checkout.quote({ items: [{ productId: id, variantId: variant.id, quantity: 1 }], currency: 'USD', fulfillment: 'pickup' }); assert.equal(quote.totalMinor, variant.priceMinor);
    }
  });
  await t.test('checkout stock reservation makes an older editor stale, preserving reserved inventory and frozen quote', async () => {
    const before = await product(); const stale = edit(before); const variant = before.variants.find((item) => item.enabled && item.stockQuantity > 0)!;
    const cart = { items: [{ productId: before.id, variantId: variant.id, quantity: 1 }], currency: 'USD' as const, fulfillment: 'pickup' as const };
    const quote = await checkout.quote(cart);
    const reserved = await checkoutStore.reserve({ ...cart, attemptId: randomUUID(), demoSessionId: quote.demoSessionId, expectedTotalMinor: quote.totalMinor });
    assert.equal((await put({ ...stale, name: 'Would overwrite stock' })).status, 409);
    assert.equal((await product()).variants.find((item) => item.id === variant.id)!.stockQuantity, variant.stockQuantity - 1);
    assert.equal(reserved.quote.totalMinor, variant.priceMinor);
    await checkoutStore.decline(reserved.attemptId);
    assert.equal((await product()).variants.find((item) => item.id === variant.id)!.stockQuantity, variant.stockQuantity);
  });
  await t.test('two stale editor saves cannot silently overwrite each other (serialized embedded connection)', async () => {
    const before = await product(); const request = edit(before);
    const responses = await Promise.all([put({ ...request, name: 'First editor' }), put({ ...request, name: 'Second editor' })]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const winner = (await responses.find((response) => response.status === 200)!.json()).product.name;
    assert.equal((await product()).name, winner);
  });
  await t.test('edited stock/enabled flags drive checkout availability; saved catalog survives database reopen', async () => {
    const before = await product(); const request = edit(before);
    request.variants[0]!.enabled = false; request.variants[1]!.stockQuantity = 3;
    const saved = await put(request); assert.equal(saved.status, 200);
    await assert.rejects(checkout.quote({ items: [{ productId: before.id, variantId: request.variants[0]!.id, quantity: 1 }], currency: 'USD', fulfillment: 'pickup' }));
    const expected = await store.load(); await db.close(); db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
    assert.deepEqual(await new PostgresAdminCatalog(db).load(), expected);
  });
});
