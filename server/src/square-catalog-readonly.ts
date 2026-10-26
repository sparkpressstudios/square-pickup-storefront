import { createHash } from 'node:crypto';
import type { Catalog, Product } from '../../shared/catalog';
import { validateCatalog } from '../../shared/catalog';
import { squareApiVersion } from './square-sandbox';
import {assertMerchantPaymentConfiguration,type MerchantPaymentServerConfig} from './merchant-payment-config';

/**
 * Read-only Square Catalog importer preview. No routes, startup hooks, database writes,
 * products made available for purchase, inventory claims, or production credentials.
 */
const origin = 'https://connect.squareupsandbox.com';
const allowedTypes = 'ITEM,CATEGORY,IMAGE,TAX,MODIFIER_LIST';
const maxPages = 5;
const maxObjects = 450;
const maxBodyBytes = 512 * 1024;
type Value = Record<string, unknown>;
const record = (value: unknown): Value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Value : {};
const textValue = (value: unknown, max = 512): string => typeof value === 'string' && !/[\u0000-\u001f\u007f]/.test(value) && value.length <= max ? value.trim() : '';
const identity = (value: unknown): string => textValue(value, 192);
const items = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const stableId = (kind: string, squareId: string) => 'sq-' + kind + '-' + createHash('sha256').update(squareId).digest('hex').slice(0, 20);
export class SquareCatalogPreviewError extends Error {
  constructor(readonly code: 'SANDBOX_CONFIGURATION' | 'NETWORK' | 'AUTHORIZATION' | 'REMOTE_ERROR' | 'INVALID_RESPONSE' | 'PAGINATION_LIMIT' | 'DUPLICATE_ID' | 'RESPONSE_TOO_LARGE') { super(code); }
}
export interface SquareCatalogPreviewConfig { environment: 'sandbox'; token: string; locationId: string }
/** Server-owned option only: Square Orders must price catalog-reference lines with auto_apply_taxes. */
export interface SquareCatalogImportOptions { readonly taxTreatment?: 'square-order-authoritative'; readonly environment?: 'production' }
export interface PreviewVariation { readonly squareId: string; readonly name: string; readonly sku: string; readonly priceMinor: number }
export interface PreviewCandidate {
  readonly squareId: string; readonly name: string; readonly description: string; readonly category: string;
  readonly imageUrl: string | null; readonly taxIds: readonly string[]; readonly modifierListIds: readonly string[];
  readonly variations: readonly PreviewVariation[]; readonly holds: readonly string[];
}
export interface SquareCatalogPreview {
  readonly mode: 'sandbox-read-only'|'production-read-only'; readonly pages: number; readonly objectsSeen: number;
  readonly candidates: readonly PreviewCandidate[]; readonly held: number; readonly draft: Catalog;
  readonly warnings: readonly string[];
}
export function previewConfiguration(values: Readonly<Record<string, string | undefined>>): SquareCatalogPreviewConfig {
  if (values.SQUARE_ENVIRONMENT !== 'sandbox' || !/^\S{16,}$/.test(values.SQUARE_SANDBOX_ACCESS_TOKEN ?? '') ||
      !/^[A-Za-z0-9]{1,64}$/.test(values.SQUARE_LOCATION_ID ?? '') ||
      !/^sandbox-sq0idb-[A-Za-z0-9_-]+$/.test(values.SQUARE_APPLICATION_ID ?? '')) throw new SquareCatalogPreviewError('SANDBOX_CONFIGURATION');
  return { environment: 'sandbox', token: values.SQUARE_SANDBOX_ACCESS_TOKEN!, locationId: values.SQUARE_LOCATION_ID! };
}
async function boundedResponse(response: Response): Promise<Value> {
  if (response.status === 401 || response.status === 403) throw new SquareCatalogPreviewError('AUTHORIZATION');
  if (!response.ok) throw new SquareCatalogPreviewError('REMOTE_ERROR');
  if (Number(response.headers.get('content-length') ?? 0) > maxBodyBytes) throw new SquareCatalogPreviewError('RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) throw new SquareCatalogPreviewError('INVALID_RESPONSE');
  const buffers: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBodyBytes) throw new SquareCatalogPreviewError('RESPONSE_TOO_LARGE');
      buffers.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new SquareCatalogPreviewError('INVALID_RESPONSE'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SquareCatalogPreviewError('INVALID_RESPONSE');
  const value = record(raw);
  // An empty Square seller catalog can legitimately return an empty object.
  if (items(value.errors).length) throw new SquareCatalogPreviewError('INVALID_RESPONSE');
  return value;
}
function safeImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash ? url.href : null;
  } catch { return null; }
}
function locationMatches(source: Value, locationId: string): boolean {
  if (source.present_at_all_locations === true) return !items(source.absent_at_location_ids).includes(locationId);
  if (source.present_at_all_locations === false) return items(source.present_at_location_ids).includes(locationId);
  return false;
}
function convert(objects: readonly unknown[], locationId: string, pages: number, options: SquareCatalogImportOptions): SquareCatalogPreview {
  const seen = new Set<string>();
  const categories = new Map<string, string>();
  const images = new Map<string, string>();
  let recognized = 0;
  for (const raw of objects) {
    const obj = record(raw); const id = identity(obj.id); const type = textValue(obj.type, 32);
    if (!id || !type) throw new SquareCatalogPreviewError('INVALID_RESPONSE');
    const key = type + '/' + id;
    if (seen.has(key)) throw new SquareCatalogPreviewError('DUPLICATE_ID');
    seen.add(key);
    if (type === 'CATEGORY') {
      const name = textValue(record(obj.category_data).name);
      if (name) categories.set(id, name);
    }
    if (type === 'IMAGE') {
      const url = safeImageUrl(record(obj.image_data).url);
      if (url) images.set(id, url);
    }
    if (['ITEM', 'CATEGORY', 'IMAGE', 'TAX', 'MODIFIER_LIST'].includes(type)) recognized++;
  }
  const candidates: PreviewCandidate[] = [];
  for (const raw of objects) {
    const obj = record(raw);
    if (obj.type !== 'ITEM' || obj.is_deleted === true) continue;
    const data = record(obj.item_data);
    const name = textValue(data.name); const squareId = identity(obj.id);
    const holds: string[] = [];
    if (!name) holds.push('INVALID_ITEM_NAME');
    if (!locationMatches(obj, locationId)) holds.push('LOCATION_UNVERIFIED');
    if (data.product_type && data.product_type !== 'REGULAR') holds.push('UNSUPPORTED_PRODUCT_TYPE');
    const taxIds = items(data.tax_ids).filter(x => typeof x === 'string').map(x => String(x));
    const modifierListIds = items(data.modifier_list_info).map(x => identity(record(x).modifier_list_id)).filter(Boolean);
    if (taxIds.length && options.taxTreatment !== 'square-order-authoritative') holds.push('TAX_RULES_REQUIRE_MAPPING');
    if (options.taxTreatment === 'square-order-authoritative' && data.tax_ids !== undefined &&
        (!Array.isArray(data.tax_ids) || data.tax_ids.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,192}$/.test(id)))) holds.push('TAX_IDENTITY_UNVERIFIED');
    if (modifierListIds.length) holds.push('MODIFIERS_REQUIRE_MAPPING');
    const variations: PreviewVariation[] = [];
    const names = new Set<string>();
    for (const vRaw of items(data.variations)) {
      const v = record(vRaw); const vData = record(v.item_variation_data);
      const varId = identity(v.id); const varName = textValue(vData.name, 255) || 'Regular';
      if (v.type !== 'ITEM_VARIATION' || !varId || v.is_deleted === true || !locationMatches(v, locationId) && v.present_at_all_locations !== undefined) {
        holds.push('VARIATION_IDENTITY_OR_LOCATION_UNVERIFIED'); continue;
      }
      if (vData.pricing_type !== 'FIXED_PRICING') { holds.push('VARIABLE_PRICING'); continue; }
      const money = record(vData.price_money);
      if (money.currency !== 'USD' || !Number.isSafeInteger(money.amount) || (money.amount as number) < 0 || (money.amount as number) > 2_147_483_647) { holds.push('INVALID_USD_PRICE'); continue; }
      if (names.has(varName)) { holds.push('DUPLICATE_VARIATION_NAMES'); continue; }
      names.add(varName);
      const sku = textValue(vData.sku, 128) || stableId('sku', varId);
      variations.push({ squareId: varId, name: varName, sku, priceMinor: money.amount as number });
    }
    if (!variations.length) holds.push('NO_SUPPORTED_VARIATIONS');
    const categoryId = identity(record(items(data.categories)[0]).id) || identity(data.category_id);
    const imageId = identity(items(data.image_ids)[0]);
    candidates.push({
      squareId, name, description: textValue(data.description, 1500) || name,
      category: categories.get(categoryId) || 'Uncategorized',
      imageUrl: images.get(imageId) ?? null, taxIds, modifierListIds,
      variations, holds: [...new Set(holds)],
    });
  }
  candidates.sort((a, b) => a.squareId.localeCompare(b.squareId));
  const products: Product[] = candidates.filter(item => item.holds.length === 0).map(item => ({
    id: stableId('item', item.squareId),
    name: item.name, description: item.description, category: item.category,
    options: item.variations.length > 1 ? [{ id: 'variation', label: 'Variation', values: item.variations.map(v => v.name) }] : [],
    variants: item.variations.map(v => ({
      id: stableId('variation', v.squareId), sku: v.sku,
      selections: item.variations.length > 1 ? { variation: v.name } as Record<string, string> : {} as Record<string, string>,
      priceMinor: v.priceMinor, stockQuantity: 0, enabled: false,
    })),
  }));
  const draft: Catalog = { currency: 'USD', products };
  try { validateCatalog(draft); } catch { throw new SquareCatalogPreviewError('INVALID_RESPONSE'); }
  return {
    mode: 'sandbox-read-only', pages, objectsSeen: objects.length, candidates,
    held: candidates.filter(item => item.holds.length > 0).length, draft,
    warnings: [
      'No live catalog or database writes were made.',
      'Draft stock is zero and every variation is disabled until verified inventory ownership is configured.',
      'Images are external URL references only; no media has been downloaded.',
      'Taxes, modifiers, inventory, customer records and production payments are not imported.',
      ...(options.taxTreatment === 'square-order-authoritative' ? ['Catalog tax references are eligible only for authoritative Square Orders pricing; local catalog prices exclude tax and must not be charged directly.'] : []),
    ],
  };
}
/** Only the caller can provide network access. No startup/network side effects from importing this module. */
export async function previewSquareSandboxCatalog(config: SquareCatalogPreviewConfig, fetcher: typeof fetch, options: SquareCatalogImportOptions = {}): Promise<SquareCatalogPreview> {
  if (config.environment !== 'sandbox' || !/^\S{16,}$/.test(config.token) || !/^[A-Za-z0-9]{1,64}$/.test(config.locationId) || typeof fetcher !== 'function') {
    throw new SquareCatalogPreviewError('SANDBOX_CONFIGURATION');
  }
  return previewCatalog(config,fetcher,options,origin);
}
export async function previewSquareMerchantCatalog(config:MerchantPaymentServerConfig,fetcher:typeof fetch,options:SquareCatalogImportOptions={}):Promise<SquareCatalogPreview>{
 assertMerchantPaymentConfiguration(config);
 const result=await previewCatalog({token:config.accessToken,locationId:config.locationId},fetcher,options,config.apiOrigin);
 return {...result,mode:config.environment==='production'?'production-read-only':'sandbox-read-only'};
}
async function previewCatalog(config:{token:string;locationId:string},fetcher:typeof fetch,options:SquareCatalogImportOptions,apiOrigin:string):Promise<SquareCatalogPreview>{
  const objects: unknown[] = []; const cursors = new Set<string>(); let pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new SquareCatalogPreviewError('PAGINATION_LIMIT');
    const url = new URL('/v2/catalog/list', apiOrigin);
    url.searchParams.set('types', allowedTypes);
    const cursor = pages ? [...cursors].at(-1) : undefined;
    if (cursor) url.searchParams.set('cursor', cursor);
    let response: Response;
    try {
      response = await fetcher(url.href, { method: 'GET', headers: {
        Authorization: 'Bearer ' + config.token, 'Square-Version': squareApiVersion, Accept: 'application/json',
      }, redirect: 'error', signal: AbortSignal.timeout(12000) });
    } catch { throw new SquareCatalogPreviewError('NETWORK'); }
    const payload = await boundedResponse(response);
    if (payload.objects !== undefined && !Array.isArray(payload.objects)) throw new SquareCatalogPreviewError('INVALID_RESPONSE');
    const nextObjects = items(payload.objects);
    if (nextObjects.length > 100 || objects.length + nextObjects.length > maxObjects) throw new SquareCatalogPreviewError('PAGINATION_LIMIT');
    objects.push(...nextObjects); pages++;
    if (payload.cursor === undefined || payload.cursor === null || payload.cursor === '') break;
    if (typeof payload.cursor !== 'string' || payload.cursor.length > 256 || cursors.has(payload.cursor)) throw new SquareCatalogPreviewError('PAGINATION_LIMIT');
    cursors.add(payload.cursor);
  }
  return convert(objects, config.locationId, pages, options);
}

