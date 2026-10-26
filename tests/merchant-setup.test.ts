import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { merchant } from '../config/merchant';
import { merchantDraft, parseMerchantDraft, applyMerchantDraft, accentInk } from '../shared/merchant-draft';
import { parseMockPickup } from '../shared/mock-pickup';
import { parseCartRequest } from '../shared/checkout';
import { MerchantSettingsPreview } from '../client/src/merchant-settings';
import { ShopHero, merchantTheme } from '../client/src/storefront-brand';
import { MockPickupForm } from '../client/src/mock-pickup-form';
import { createApp } from '../server/src/app';
import { ProductImage } from '../client/src/product-card';
import { demoCatalog } from '../config/demo-catalog';

test('presentation drafts normalize allowed values without changing merchant commerce or media configuration', () => {
  const before = structuredClone(merchant);
  const input = { ...merchantDraft(merchant), name: '  Fictional Candle Shop  ', tagline: 'Our demo collection', accent: '#2233aa', background: '#ffffff', pickupInstructions: 'Line one\r\nLine two' };
  const updated = applyMerchantDraft(merchant, input);
  assert.equal(updated.name, 'Fictional Candle Shop');
  assert.equal(updated.theme.accent, '#2233AA');
  assert.equal(updated.theme.background, '#FFFFFF');
  assert.equal(updated.pickup.instructions, 'Line one\nLine two');
  assert.equal(updated.media, merchant.media);
  assert.equal(updated.currency, 'USD'); assert.equal(updated.fulfillment, 'pickup');
  assert.deepEqual(merchant, before);
});

test('presentation settings refuse credentials, media URLs, commerce switches and malformed or inherited fields', () => {
  const valid = merchantDraft(merchant);
  for (const input of [null, [], Object.create(valid), { ...valid, accessToken: 'not-a-real-token' }, { ...valid, media: { hero: 'https://untrusted.invalid' } }, { ...valid, currency: 'EUR' }, { ...valid, fulfillment: 'shipping' }, { ...valid, name: '' }, { ...valid, name: 'x'.repeat(81) }, { ...valid, name: 'Two\nLines' }, { ...valid, introduction: 'bad\u0000copy' }, { ...valid, accent: 'url(javascript:bad)' }, { ...valid, accent: '#abc' }, { ...valid, background: '#000000' }]) assert.throws(() => parseMerchantDraft(input));
});

test('accent button text chooses readable black/white for bright, dark and mid-tone brands', () => {
  for (const [color, expected] of [['#000000','#FFFFFF'],['#FFFFFF','#000000'],['#A1AB74','#000000'],['#777777','#000000'],['#0044AA','#FFFFFF'],['#FF0000','#000000'],['#00FF00','#000000'],['#0000FF','#FFFFFF']]) assert.equal(accentInk(color!), expected);
  assert.throws(() => accentInk('white'));
});

test('shared storefront header renders configured copy; preview is escaped, non-secret and explicitly temporary', () => {
  const brand = applyMerchantDraft(merchant, { ...merchantDraft(merchant), name: '<script>fake</script>', tagline: 'A fictional food and home shop' });
  const hero = renderToStaticMarkup(createElement(ShopHero, { merchant: brand }));
  assert.match(hero, /A fictional food and home shop/);
  const html = renderToStaticMarkup(createElement(MerchantSettingsPreview, { merchant: brand, baseline: merchant, onApply: () => {} }));
  assert.match(html, /&lt;script&gt;fake&lt;\/script&gt;/); assert.doesNotMatch(html, /<script/);
  assert.match(html, /Saving changes this preview tab only/);
  assert.match(html, /staff APIs remain closed/);
  assert.match(html, /real Square acceptance not run/);
  assert.doesNotMatch(html, /name="(?:password|token|accessToken|databaseUrl|mediaUrl)"/i);
  assert.match(html, /Read-only preview/);
  assert.equal((merchantTheme(brand) as Record<string,string>)['--accent-ink'], '#000000');
});

test('merchant product images support a single local photo without changing the demo atlas layout', () => {
  const product = demoCatalog.products[0]!;
  const single = renderToStaticMarkup(createElement(ProductImage, { product, media: { hero: '/images/fictional.jpg', products: { [product.id]: { src: '/images/fictional.jpg', position: 'center' } } } }));
  assert.match(single, /background-size:cover/);
  const atlas = renderToStaticMarkup(createElement(ProductImage, { product, media: merchant.media }));
  assert.match(atlas, /background-size:200% 200%/);
});

test('mock pickup requires a fictional contact and explicit simulation acknowledgment', () => {
  assert.deepEqual(parseMockPickup({ name: ' Demo Shopper ', email: 'SHOPPER@EXAMPLE.INVALID', acknowledged: true }), { name: 'Demo Shopper', email: 'shopper@example.invalid', acknowledged: true });
  const valid = { name: 'Demo Shopper', email: 'shopper@example.invalid', acknowledged: true };
  for (const input of [null, Object.create(valid), { ...valid, phone: 'not-accepted' }, { ...valid, name: 'x' }, { ...valid, name: 'a'.repeat(101) }, { ...valid, name: 'Bad\nName' }, { ...valid, email: 'person@example.com' }, { ...valid, email: 'shopper@example.invalid.attacker.test' }, { ...valid, email: 'not-an-email' }, { ...valid, acknowledged: false }, { ...valid, acknowledged: 'true' }]) assert.throws(() => parseMockPickup(input));
});

test('fictional contact preview cannot be included in authoritative checkout cart payloads', () => {
  const contact = parseMockPickup({ name: 'Demo Shopper', email: 'shopper@example.invalid', acknowledged: true });
  const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD', fulfillment: 'pickup' };
  assert.throws(() => parseCartRequest({ ...cart, customer: contact }));
  const html = renderToStaticMarkup(createElement(MockPickupForm, { busy: false, onReady: () => {} }));
  assert.match(html, /shopper@example.invalid/); assert.match(html, /never sent to the server, Square or email/);
  assert.match(html, /type="checkbox"/); assert.match(html, /autoComplete="off"/);
  assert.doesNotMatch(html, /type="(?:password|tel)"/);
});

test('public synthetic brand preview grants no staff settings access or public storefront mutation', async (t) => {
  const app = await createApp(); const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const changed = applyMerchantDraft(merchant, { ...merchantDraft(merchant), name: 'Another Fictional Store' });
  for (const path of ['/api/admin/settings','/api/admin/brand']) {
    const response = await fetch(origin+path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Role': 'admin', Origin: origin }, body: JSON.stringify(changed) });
    assert.equal(response.status, 401);
  }
  const response = await (await fetch(origin+'/api/storefront')).json();
  assert.equal(response.merchant.name, merchant.name);
  assert.equal(response.capabilities.square, false); assert.equal(response.capabilities.outboundMail, false); assert.equal(response.capabilities.schedulers, false);
});
