import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { demoCatalog } from '../config/demo-catalog';
import { merchant } from '../config/merchant';
import { formatPrice, resolveVariant, validateCatalog, variantAvailability, type Catalog } from '../shared/catalog';
import { CatalogPage } from '../client/src/catalog-page';
import { ProductCard } from '../client/src/product-card';
import { capabilities } from '../server/src/app';

const candle = demoCatalog.products[0]!;

test('mixed retail demo validates with generic multi-option, single-option, and no-option products', () => {
  assert.doesNotThrow(() => validateCatalog(demoCatalog));
  assert.deepEqual(demoCatalog.products.map((p) => p.options.length), [2, 1, 0, 1]);
});

test('food and non-food products resolve through the same generic model', () => {
  const granola = demoCatalog.products.find((product) => product.id === 'pantry-granola')!;
  assert.equal(resolveVariant(granola, { blend: 'Cocoa' })?.priceMinor, 900);
  assert.equal(variantAvailability(resolveVariant(granola, { blend: 'Maple' })), 'available');
  assert.equal(resolveVariant(candle, { scent: 'Cedar', vessel: 'Chalk' })?.priceMinor, 2800);
});

test('exact variant selection changes price without trusting option key order', () => {
  assert.equal(resolveVariant(candle, { vessel: 'Amber', scent: 'Cedar' })?.priceMinor, 2400);
  assert.equal(resolveVariant(candle, { scent: 'Cedar', vessel: 'Chalk' })?.priceMinor, 2800);
  const trimmer = demoCatalog.products[2]!;
  assert.equal(resolveVariant(trimmer, {})?.id, 'trimmer-brass');
});

test('missing, extra, unknown, and inherited option selections do not resolve', () => {
  for (const selections of [{ scent: 'Cedar' }, { scent: 'Cedar', vessel: 'Unknown' }, { scent: 'Cedar', vessel: 'Amber', priceMinor: '1' }, Object.create({ scent: 'Cedar', vessel: 'Amber' })]) {
    assert.equal(resolveVariant(candle, selections), undefined);
  }
});

test('sold-out and disabled variants remain distinguishable from available stock', () => {
  assert.equal(variantAvailability(resolveVariant(candle, { scent: 'Cedar', vessel: 'Amber' })), 'available');
  assert.equal(variantAvailability(resolveVariant(candle, { scent: 'Sage', vessel: 'Amber' })), 'sold_out');
  assert.equal(variantAvailability(resolveVariant(candle, { scent: 'Sage', vessel: 'Chalk' })), 'unavailable');
  assert.equal(variantAvailability(undefined), 'unavailable');
});

test('unsupported currency and invalid integer money/stock fail before serving', () => {
  const invalidCurrency = { ...demoCatalog, currency: 'EUR' } as unknown as Catalog;
  assert.throws(() => validateCatalog(invalidCurrency), /only USD/);
  for (const field of ['priceMinor', 'stockQuantity'] as const) {
    for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
      const catalog = structuredClone(demoCatalog);
      (catalog.products[0]!.variants[0]! as unknown as Record<string, unknown>)[field] = value;
      assert.throws(() => validateCatalog(catalog), /integer/);
    }
  }
  assert.equal(formatPrice(1, 'USD'), '$0.01');
  assert.equal(formatPrice(2400, 'USD'), '$24.00');
});

test('catalog integrity rejects duplicate identities, SKUs, and ambiguous combinations', () => {
  for (const field of ['id', 'sku', 'selections'] as const) {
    const catalog = structuredClone(demoCatalog);
    const first = catalog.products[0]!.variants[0]!;
    const second = catalog.products[0]!.variants[1]! as unknown as Record<string, unknown>;
    second[field] = first[field];
    assert.throws(() => validateCatalog(catalog), /duplicate/);
  }
  const catalog = { ...demoCatalog, products: [candle, candle] };
  assert.throws(() => validateCatalog(catalog), /duplicate product/);
});

test('catalog integrity rejects missing or unknown variant values and empty option definitions', () => {
  const invalid = (selections: Record<string, string>) => ({ ...demoCatalog, products: [{ ...candle, variants: [{ ...candle.variants[0]!, selections }] }] });
  assert.throws(() => validateCatalog(invalid({ scent: 'Cedar' })), /count mismatch/);
  assert.throws(() => validateCatalog(invalid({ scent: 'Cedar', vessel: 'Unknown' })), /unknown or missing/);
  assert.throws(() => validateCatalog({ ...demoCatalog, products: [{ ...candle, options: [{ ...candle.options[0]!, values: [] }] }] }), /empty or duplicate/);
});

test('merchant copy and theme are configuration, and the catalog renders as a clearly labeled demo', () => {
  const html = renderToStaticMarkup(createElement(CatalogPage, { storefront: { merchant: { ...merchant, name: 'Another merchant' }, catalog: demoCatalog, mode: 'synthetic-demo', capabilities } }));
  assert.match(html, /Another merchant/);
  assert.match(html, /SYNTHETIC STORE DEMO/);
  assert.match(html, /USD/);
  assert.match(html, /Pickup only/);
  assert.match(html, /Mock checkout \/ no real payments/);
  assert.match(html, /Your demo cart, 0 items/);
  assert.match(html, /aria-label="Shopping progress"/);
  assert.match(html, /disabled="" aria-describedby="checkout-prerequisite"[^>]*><span>3<\/span>Checkout/);
  assert.match(html, /id="checkout-prerequisite"[^>]*role="status">Add an item to your cart before checkout\./);
  assert.match(html, /Select more Studio candle/);
  assert.match(html, /Add to demo cart/);
  assert.match(html, /Studio candle/);
  assert.match(html, /Ceramic catchall/);
  assert.match(html, /Pantry granola/);
  assert.match(html, /\$24\.00/);
  assert.match(html, /type="radio"/);
  assert.doesNotMatch(html, /<form|<img|https?:\/\//);
});

test('product detail shares generic food/non-food options and safe unavailable controls without merchant assets', () => {
  for (const product of [candle, demoCatalog.products[3]!]) {
    const html = renderToStaticMarkup(createElement(ProductCard, { product, currency: 'USD', media: merchant.media, onAdd: () => true, cartLocked: false, detail: true }));
    assert.match(html, /<h1/);
    assert.match(html, /product-detail/);
    assert.match(html, /Synthetic demo/);
    assert.match(html, /No real|does not create a real/);
    assert.match(html, /demo-product-atlas.png/);
    assert.doesNotMatch(html, /Urban Churn|uc-logo|uc-pints|https?:\/\//);
  }
});

