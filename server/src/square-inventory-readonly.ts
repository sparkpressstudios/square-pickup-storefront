import { squareApiVersion } from './square-sandbox';
import type { SquareCatalogPreviewConfig } from './square-catalog-readonly';

/** Read-only Square POS inventory evidence for one exact location.
 * Does not reserve, modify, import, or activate stock in either system. */
export class SquareInventoryPreviewError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'AUTHORIZATION' | 'REMOTE_ERROR' |
    'INVALID_RESPONSE' | 'PAGINATION_LIMIT' | 'AMBIGUOUS_COUNTS') { super(code); }
}
export interface SquareInventoryEvidence {
  readonly squareVariationId: string; readonly locationId: string;
  readonly quantity: number | null;
  readonly calculatedAt: string | null;
  readonly state: 'verified' | 'hold';
  readonly reason: 'NO_TRACKED_COUNT' | 'UNSUPPORTED_QUANTITY' | 'NO_TIMESTAMP' | null;
}
export interface SquareInventoryPreview {
  readonly mode: 'sandbox-read-only';
  readonly inventoryOwner: 'square';
  readonly locationId: string;
  readonly pages: number;
  readonly verified: number;
  readonly held: number;
  readonly evidence: readonly SquareInventoryEvidence[];
  readonly enabledProducts: 0;
}
const endpoint = 'https://connect.squareupsandbox.com/v2/inventory/counts/batch-retrieve';
const maxPages = 4;
const maxBytes = 192 * 1024;
type Json = Record<string, unknown>;
const plain = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
async function responseObject(response: Response): Promise<Json> {
  if (response.status === 401 || response.status === 403) throw new SquareInventoryPreviewError('AUTHORIZATION');
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > maxBytes)
    throw new SquareInventoryPreviewError('REMOTE_ERROR');
  const reader = response.body?.getReader(); if (!reader) throw new SquareInventoryPreviewError('INVALID_RESPONSE');
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > maxBytes) throw new SquareInventoryPreviewError('REMOTE_ERROR');
      parts.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new SquareInventoryPreviewError('INVALID_RESPONSE'); }
  if (!plain(value) || (value.errors !== undefined && (!Array.isArray(value.errors) || value.errors.length > 0)))
    throw new SquareInventoryPreviewError('INVALID_RESPONSE');
  return value;
}
function exactInteger(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,9})$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count <= 2_147_483_647 ? count : null;
}
export async function previewSquareSandboxInventory(config: SquareCatalogPreviewConfig,
  squareVariationIds: readonly string[], fetcher: typeof fetch): Promise<SquareInventoryPreview> {
  if (config.environment !== 'sandbox' || !/^\S{16,}$/.test(config.token) ||
      !/^[A-Za-z0-9]{1,64}$/.test(config.locationId) || typeof fetcher !== 'function' ||
      !Array.isArray(squareVariationIds) || !squareVariationIds.length || squareVariationIds.length > 100 ||
      squareVariationIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,192}$/.test(id)) ||
      new Set(squareVariationIds).size !== squareVariationIds.length)
    throw new SquareInventoryPreviewError('INVALID_REQUEST');
  const requested = [...squareVariationIds].sort();
  const validIds = new Set(requested);
  const observed = new Map<string, { quantity: unknown; calculated_at: unknown }>();
  const cursors = new Set<string>();
  let cursor: string | undefined, pages = 0;
  for (;;) {
    if (pages >= maxPages) throw new SquareInventoryPreviewError('PAGINATION_LIMIT');
    let response: Response;
    try {
      response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: 'Bearer ' + config.token, 'Square-Version': squareApiVersion,
          'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ catalog_object_ids: requested, location_ids: [config.locationId],
          states: ['IN_STOCK'], limit: 100, ...(cursor ? { cursor } : {}) }),
      });
    } catch { throw new SquareInventoryPreviewError('REMOTE_ERROR'); }
    const data = await responseObject(response);
    if (data.counts !== undefined && !Array.isArray(data.counts)) throw new SquareInventoryPreviewError('INVALID_RESPONSE');
    const rows = data.counts as unknown[] | undefined ?? [];
    if (rows.length > 100) throw new SquareInventoryPreviewError('PAGINATION_LIMIT');
    for (const raw of rows) {
      if (!plain(raw) || !validIds.has(String(raw.catalog_object_id)) ||
          raw.catalog_object_type !== 'ITEM_VARIATION' ||
          raw.location_id !== config.locationId || raw.state !== 'IN_STOCK')
        throw new SquareInventoryPreviewError('INVALID_RESPONSE');
      const sourceId = String(raw.catalog_object_id);
      if (observed.has(sourceId)) throw new SquareInventoryPreviewError('AMBIGUOUS_COUNTS');
      observed.set(sourceId, { quantity: raw.quantity, calculated_at: raw.calculated_at });
    }
    pages++;
    if (data.cursor == null || data.cursor === '') break;
    if (typeof data.cursor !== 'string' || data.cursor.length > 256 || cursors.has(data.cursor))
      throw new SquareInventoryPreviewError('PAGINATION_LIMIT');
    cursor = data.cursor;
    cursors.add(data.cursor);
  }
  const evidence: SquareInventoryEvidence[] = requested.map(id => {
    const raw = observed.get(id);
    if (!raw) return { squareVariationId: id, locationId: config.locationId,
      quantity: null, calculatedAt: null, state: 'hold', reason: 'NO_TRACKED_COUNT' };
    const quantity = exactInteger(raw.quantity);
    if (quantity === null) return { squareVariationId: id, locationId: config.locationId,
      quantity: null, calculatedAt: null, state: 'hold', reason: 'UNSUPPORTED_QUANTITY' };
    const calculated = raw.calculated_at;
    if (typeof calculated !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(calculated) ||
        !Number.isFinite(Date.parse(calculated))) return { squareVariationId: id,
      locationId: config.locationId, quantity: null, calculatedAt: null, state: 'hold', reason: 'NO_TIMESTAMP' };
    return { squareVariationId: id, locationId: config.locationId, quantity,
      calculatedAt: calculated, state: 'verified', reason: null };
  });
  return { mode: 'sandbox-read-only', inventoryOwner: 'square', locationId: config.locationId,
    pages, evidence, verified: evidence.filter(x => x.state === 'verified').length,
    held: evidence.filter(x => x.state === 'hold').length, enabledProducts: 0 };
}
