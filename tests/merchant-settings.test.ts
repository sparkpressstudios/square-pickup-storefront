import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { merchant } from '../config/merchant';
import { merchantDraft } from '../shared/merchant-draft';
import { parseMerchantSettingsRequest } from '../shared/merchant-settings';
import { migrateSyntheticDatabase } from '../db/migrate';
import { createApp } from '../server/src/app';
import { PostgresMerchantSettings } from '../server/src/merchant-settings';
import type { StaffPrincipal } from '../server/src/admin-catalog';
import { MerchantSettingsEditor } from '../client/src/merchant-settings';

test('persistent settings editor distinguishes database saves from public tab-only preview', () => {
  const html = renderToStaticMarkup(createElement(MerchantSettingsEditor, { merchant, baseline: merchant, onApply: () => {}, onSave: async () => {}, onReload: () => {} }));
  assert.match(html, /Database backed/); assert.match(html, /Save store settings/);
  assert.match(html, /appear on the storefront after reload/); assert.match(html, /verified administrator session required/);
  assert.doesNotMatch(html, /Saving changes this preview tab only|Reloading restores the original demo/);
});

test('persistent settings request is a strict non-secret presentation envelope', () => {
  const input = { settings: merchantDraft(merchant), revision: 'a'.repeat(64) };
  assert.deepEqual(parseMerchantSettingsRequest(input), input);
  for (const value of [null, [], {}, { ...input, csrfToken: 'forged' }, { ...input, revision: '' }, { ...input, revision: 1 }, { ...input, settings: { ...input.settings, token: 'not-a-token' } }, { ...input, settings: { ...input.settings, currency: 'EUR' } }, { ...input, settings: { ...input.settings, media: {} } }]) assert.throws(() => parseMerchantSettingsRequest(value));
});

test('database-backed settings persist, protect concurrent edits and serve only public presentation', async (t) => {
  const directory = join(await mkdtemp(join(tmpdir(), 'square-settings-synthetic-')), 'pgdata');
  let db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
  let store = new PostgresMerchantSettings(db, merchant);
  const original = await store.load(); assert.equal(original.updatedAt, null);
  let principal: StaffPrincipal | null = null;
  const csrfToken = 'synthetic-settings-csrf-for-tests';
  const app = await createApp(undefined, { localDatabase: true, admin: { settings: store, verifyStaff: async () => principal } });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await db.close(); });
  const get = (path = '/api/admin/settings') => fetch(origin + path);
  const put = (body: unknown, extra: Record<string, string> = {}) => fetch(origin + '/api/admin/settings', { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken, ...extra }, body: JSON.stringify(body) });
  const request = { revision: original.revision, settings: { ...original.settings, name: 'Fictional Food & Home', accent: '#003366', pickupInstructions: 'Synthetic pickup desk only.' } };

  await t.test('forged identity, staff and manager cannot read or change store-wide settings', async () => {
    assert.equal((await get()).status, 401); assert.equal((await put({ ...request, role: 'admin' }, { 'X-Role': 'admin' })).status, 401);
    for (const role of ['staff', 'manager'] as const) { principal = { id: 'test-' + role, role, csrfToken }; assert.equal((await get()).status, 403); assert.equal((await put(request)).status, 403); }
    const session = await (await get('/api/admin/session')).json(); assert.equal(session.settingsEditing, false);
    assert.deepEqual(await store.load(), original);
  });
  await t.test('administrator writes require current CSRF, origin and JSON; fields validate before mutation', async () => {
    principal = { id: 'synthetic-admin', role: 'admin', csrfToken };
    const refusedHeaders: Record<string, string>[] = [{ Origin: '' }, { Origin: 'https://foreign.invalid' }, { 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }];
    for (const headers of refusedHeaders) assert.equal((await put(request, headers)).status, 403);
    assert.equal((await put(request, { 'Content-Type': 'text/plain' })).status, 415);
    for (const settings of [{ ...request.settings, token: 'not-real' }, { ...request.settings, name: '' }, { ...request.settings, accent: 'url(unsafe)' }, { ...request.settings, pickupInstructions: '\u0000' }]) assert.equal((await put({ ...request, settings })).status, 400);
    assert.deepEqual(await store.load(), original);
  });
  await t.test('saved values reach fresh storefront reads without changing checkout, catalog or media', async () => {
    const before = await (await get('/api/storefront')).json();
    const response = await put(request); assert.equal(response.status, 200);
    const saved = await response.json(); assert.notEqual(saved.revision, original.revision); assert.ok(saved.updatedAt);
    const after = await (await get('/api/storefront')).json();
    assert.equal(after.merchant.name, request.settings.name); assert.equal(after.merchant.pickup.instructions, request.settings.pickupInstructions);
    assert.equal(after.merchant.theme.accent, '#003366'); assert.deepEqual(after.merchant.media, before.merchant.media);
    assert.deepEqual(after.catalog, before.catalog); assert.deepEqual(after.capabilities, before.capabilities);
    assert.equal(after.merchant.currency, 'USD'); assert.equal(after.merchant.fulfillment, 'pickup');
    assert.doesNotMatch(JSON.stringify(after), /synthetic-admin|updated_by|updatedAt|revision/);
    assert.equal((await db.query<{ updated_by: string }>('SELECT updated_by FROM merchant_presentation WHERE singleton=true')).rows[0]!.updated_by, 'synthetic-admin');
    assert.equal((await get()).headers.get('cache-control'), 'no-store');
  });
  await t.test('stale and competing writers cannot silently overwrite changes or reset versions', async () => {
    assert.equal((await put(request)).status, 409);
    const saved = await store.load();
    const results = await Promise.allSettled(['First', 'Second'].map(name => store.update({ revision: saved.revision, settings: { ...saved.settings, name: `Fictional ${name}` } }, 'synthetic-admin')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const rejected = results.find(r => r.status === 'rejected'); assert.equal(rejected?.status === 'rejected' ? rejected.reason.code : '', 'SETTINGS_CHANGED');
    const latest = await store.load(); assert.notEqual(latest.revision, saved.revision);
    const again = await store.update({ revision: latest.revision, settings: latest.settings }, 'synthetic-admin'); assert.notEqual(again.revision, latest.revision);
  });
  await t.test('reopening and rerunning migrations preserve settings and catalog without reseeding', async () => {
    const saved = await store.load();
    await db.query('UPDATE catalog_variants SET stock_quantity=17 WHERE id=$1', ['candle-cedar-amber']);
    await db.close(); db = await PGlite.create(directory, { relaxedDurability: false }); await migrateSyntheticDatabase(db);
    store = new PostgresMerchantSettings(db, merchant); assert.deepEqual(await store.load(), saved);
    assert.equal((await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM catalog_variants WHERE id=$1', ['candle-cedar-amber'])).rows[0]!.stock_quantity, 17);
    assert.equal((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM starter_schema_migrations')).rows[0]!.count, 6);
  });
});
