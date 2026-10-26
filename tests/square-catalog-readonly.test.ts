import assert from 'node:assert/strict';
import test from 'node:test';
import { SquareCatalogPreviewError, previewConfiguration, previewSquareSandboxCatalog } from '../server/src/square-catalog-readonly';
import { validateCatalog } from '../shared/catalog';

const values = {
  SQUARE_ENVIRONMENT: 'sandbox', SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test-public-id',
  SQUARE_LOCATION_ID: 'LOCATION123', SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-token-without-square-access',
};
const config = previewConfiguration(values);
const goodItem = (id = 'ITEM_ONE', sku = 'SKU-S', extra = {}) => ({
  type: 'ITEM', id, present_at_all_locations: true,
  item_data: { name: 'Granola', description: 'Test pantry item', categories: [{ id: 'CATEGORY' }], image_ids: ['IMAGE_1'], variations: [{
    type: 'ITEM_VARIATION', id: 'VAR_' + id, present_at_all_locations: true,
    item_variation_data: { name: 'Standard', pricing_type: 'FIXED_PRICING', sku, price_money: { amount: 650, currency: 'USD' } },
  }], ...extra },
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('authoritative tax opt-in admits catalog references but never modifiers, malformed taxes or enabled stock', async () => {
  const fetcher: typeof fetch = async () => reply({ objects: [
    goodItem('TAXED', 'SKU-T', { tax_ids: ['TAX_1'] }),
    goodItem('MODIFIED', 'SKU-M', { tax_ids: ['TAX_1'], modifier_list_info: [{ modifier_list_id: 'MOD_1' }] }),
    goodItem('BAD_TAX', 'SKU-B', { tax_ids: [123] }),
  ] });
  const ordinary = await previewSquareSandboxCatalog(config, fetcher);
  assert.deepEqual(ordinary.candidates.find(c => c.squareId === 'TAXED')?.holds, ['TAX_RULES_REQUIRE_MAPPING']);
  const preview = await previewSquareSandboxCatalog(config, fetcher, { taxTreatment: 'square-order-authoritative' });
  assert.equal(preview.draft.products.length, 1);
  assert.deepEqual(preview.candidates.find(c => c.squareId === 'TAXED')?.taxIds, ['TAX_1']);
  assert.deepEqual(preview.candidates.find(c => c.squareId === 'TAXED')?.holds, []);
  assert.deepEqual(preview.candidates.find(c => c.squareId === 'MODIFIED')?.holds, ['MODIFIERS_REQUIRE_MAPPING']);
  assert.deepEqual(preview.candidates.find(c => c.squareId === 'BAD_TAX')?.holds, ['TAX_IDENTITY_UNVERIFIED']);
  assert.equal(preview.draft.products[0]!.variants[0]!.enabled, false);
  assert.equal(preview.draft.products[0]!.variants[0]!.stockQuantity, 0);
  assert.match(preview.warnings.join(' '), /must not be charged directly/);
});

test('credentials must be dedicated sandbox server values, never production or placeholders', () => {
  for (const changed of [
    { SQUARE_ENVIRONMENT: 'production' }, { SQUARE_LOCATION_ID: undefined },
    { SQUARE_APPLICATION_ID: 'sq0idp-production' }, { SQUARE_SANDBOX_ACCESS_TOKEN: '' },
  ]) assert.throws(() => previewConfiguration({ ...values, ...changed }), (error: unknown) => error instanceof SquareCatalogPreviewError && error.code === 'SANDBOX_CONFIGURATION');
});

test('paginated read-only catalog yields stable, disabled inventory-safe draft and source metadata', async () => {
  const calls: { url: string; headers: HeadersInit | undefined; method: string | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push({ url: url.href, headers: init?.headers, method: init?.method });
    assert.equal(url.origin, 'https://connect.squareupsandbox.com');
    assert.equal(url.pathname, '/v2/catalog/list');
    assert.equal(url.searchParams.get('types'), 'ITEM,CATEGORY,IMAGE,TAX,MODIFIER_LIST');
    return url.searchParams.get('cursor') === 'PAGE_TWO' ? reply({ objects: [{
      ...goodItem('ITEM_TAXED', 'SKU-T', { tax_ids: ['TAX_1'], modifier_list_info: [{ modifier_list_id: 'MODIFIERS_1' }] }),
    }] }) : reply({ objects: [
      { type: 'CATEGORY', id: 'CATEGORY', category_data: { name: 'Pantry' } },
      { type: 'IMAGE', id: 'IMAGE_1', image_data: { url: 'https://example.com/food.png' } },
      goodItem(),
    ], cursor: 'PAGE_TWO' });
  };
  const preview = await previewSquareSandboxCatalog(config, fetcher);
  assert.equal(preview.mode, 'sandbox-read-only');
  assert.equal(preview.pages, 2);
  assert.equal(preview.objectsSeen, 4);
  assert.equal(preview.candidates.length, 2);
  assert.equal(preview.held, 1);
  assert.deepEqual(preview.candidates.find(c => c.squareId === 'ITEM_TAXED')?.holds, ['TAX_RULES_REQUIRE_MAPPING','MODIFIERS_REQUIRE_MAPPING']);
  assert.equal(preview.candidates.find(c => c.squareId === 'ITEM_ONE')?.category, 'Pantry');
  assert.equal(preview.candidates.find(c => c.squareId === 'ITEM_ONE')?.imageUrl, 'https://example.com/food.png');
  assert.equal(preview.draft.products.length, 1);
  const variant = preview.draft.products[0]!.variants[0]!;
  assert.equal(variant.stockQuantity, 0);
  assert.equal(variant.enabled, false);
  assert.equal(variant.priceMinor, 650);
  validateCatalog(preview.draft);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.method, 'GET');
  assert.match(String((calls[0]?.headers as Record<string,string>).Authorization), /synthetic-token/);
  const duplicateRun = await previewSquareSandboxCatalog(config, fetcher);
  assert.deepEqual(duplicateRun.draft, preview.draft);
  assert.doesNotMatch(JSON.stringify(preview), /synthetic-token-without-square-access/);
});

test('unsupported pricing, location, product type and duplicated names remain held without sellable products', async () => {
  const fixture = [
    { ...goodItem('BAD_LOC'), present_at_all_locations: false, present_at_location_ids: ['OTHER'] },
    { ...goodItem('BAD_TYPE'), item_data: { ...goodItem('BAD_TYPE').item_data, product_type: 'APPOINTMENTS_SERVICE' } },
    { ...goodItem('BAD_PRICE'), item_data: { ...goodItem('BAD_PRICE').item_data, variations: [{
      type: 'ITEM_VARIATION', id: 'V_BAD_PRICE', item_variation_data: { name: 'Price at purchase', pricing_type: 'VARIABLE_PRICING' },
    }] } },
    { ...goodItem('BAD_VARIANTS'), item_data: { ...goodItem('BAD_VARIANTS').item_data, variations: [
      { type: 'ITEM_VARIATION', id: 'V_A', item_variation_data: { name: 'One', pricing_type: 'FIXED_PRICING', price_money: { amount: 100, currency: 'USD' } } },
      { type: 'ITEM_VARIATION', id: 'V_B', item_variation_data: { name: 'One', pricing_type: 'FIXED_PRICING', price_money: { amount: 200, currency: 'USD' } } },
    ] } },
  ];
  const preview = await previewSquareSandboxCatalog(config, async () => reply({ objects: fixture }));
  assert.equal(preview.candidates.length, 4);
  assert.equal(preview.held, 4);
  assert.equal(preview.draft.products.length, 0);
});

test('pagination bounds, cursor loops, duplicate IDs, remote errors and malformed data fail closed', async () => {
  const repeated = async () => reply({ objects: [], cursor: 'SAME' });
  await assert.rejects(previewSquareSandboxCatalog(config, repeated), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'PAGINATION_LIMIT');
  await assert.rejects(previewSquareSandboxCatalog(config, async () => reply({ objects: [goodItem(), goodItem()] })), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'DUPLICATE_ID');
  await assert.rejects(previewSquareSandboxCatalog(config, async () => reply({}, 401)), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'AUTHORIZATION');
  await assert.rejects(previewSquareSandboxCatalog(config, async () => reply({ errors: [{ detail: 'private message' }] })), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'INVALID_RESPONSE' && !e.message.includes('private'));
  await assert.rejects(previewSquareSandboxCatalog(config, async () => reply({ objects: 'not-array' })), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'INVALID_RESPONSE');
  await assert.rejects(previewSquareSandboxCatalog(config, async () => new Response('x'.repeat(512 * 1024 + 1), { status: 200 })), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'RESPONSE_TOO_LARGE');
  await assert.rejects(previewSquareSandboxCatalog(config, async () => { throw new Error(values.SQUARE_SANDBOX_ACCESS_TOKEN); }), (e: unknown) => e instanceof SquareCatalogPreviewError && e.code === 'NETWORK' && !e.message.includes('synthetic-token'));
});

test('an empty Square seller catalog returns a valid empty preview, never an import', async () => {
  const preview = await previewSquareSandboxCatalog(config, async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/v2/catalog/list');
    assert.equal(init?.method, 'GET');
    return reply({});
  });
  assert.equal(preview.pages, 1);
  assert.equal(preview.objectsSeen, 0);
  assert.equal(preview.candidates.length, 0);
  assert.equal(preview.held, 0);
  assert.deepEqual(preview.draft, { currency: 'USD', products: [] });
});

