import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import { validateCatalog, type Catalog, type Product, type Variant } from '../../shared/catalog';
import type { SquareCatalogPreview, PreviewCandidate, PreviewVariation, SquareCatalogImportOptions } from './square-catalog-readonly';

/**
 * Explicit, no-network, no-runtime-hook catalog staging for a *separate fresh*
 * merchant database. Not a public endpoint or authenticated staff API.
 * Synthetic checkout databases cannot pass the target marker.
 */
export type InventoryOwner = 'square' | 'website';
export interface MerchantCatalogIdentity {
  readonly squareMerchantId: string;
  readonly squareLocationId: string;
}
export interface SquareImportLink {
  readonly squareItemId: string;
  readonly productId: string;
  readonly variants: readonly { readonly squareVariationId: string; readonly variantId: string }[];
}
export interface MerchantImportPlan {
  readonly taxTreatment?: 'square-order-authoritative';
  readonly squareMerchantId: string;
  readonly squareLocationId: string;
  readonly inventoryOwner: InventoryOwner;
  readonly reviewHolds: number;
  readonly catalog: Catalog;
  readonly sourceLinks: readonly SquareImportLink[];
}
export interface MerchantStageResult {
  readonly fingerprint: string; readonly state: 'staged' | 'committed';
  readonly reviewHolds: number; readonly productCount: number; readonly variantCount: number;
  readonly inventoryOwner: InventoryOwner; readonly checkoutEnabled: false;
  readonly reused: boolean;
}
export class MerchantImportError extends Error {
  constructor(readonly code: 'INVALID_IDENTITY' | 'NOT_EMPTY' | 'TARGET_UNVERIFIED' |
    'PREVIEW_INVALID' | 'NO_ELIGIBLE_PRODUCTS' | 'IMPORT_CONFLICT' |
    'REVIEW_REQUIRED' | 'FINGERPRINT_MISMATCH' | 'STAGE_NOT_FOUND') { super(code); }
}
const id = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max &&
  /^[A-Za-z0-9_-]+$/.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) :
  value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])])) : value;
const squareProductId = (kind: string, sourceId: string) =>
  'sq-' + kind + '-' + createHash('sha256').update(sourceId).digest('hex').slice(0, 20);
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const ownerValid = (value: unknown): value is InventoryOwner => value === 'square' || value === 'website';
function requireIdentity(identity: MerchantCatalogIdentity): void {
  if (!id(identity.squareMerchantId, 192) || !id(identity.squareLocationId, 64)) throw new MerchantImportError('INVALID_IDENTITY');
}
async function identityRow(tx: SqlExecutor, expected: MerchantCatalogIdentity, lock = false): Promise<{ inventory_owner: string }> {
  let rows: { dataset: string; square_merchant_id: string; square_location_id: string; inventory_owner: string; checkout_enabled: boolean }[];
  try {
    rows = (await tx.query<typeof rows[number]>(
      'SELECT dataset,square_merchant_id,square_location_id,inventory_owner,checkout_enabled FROM merchant_catalog_identity WHERE singleton=true' + (lock ? ' FOR UPDATE' : ''))).rows;
  } catch { throw new MerchantImportError('TARGET_UNVERIFIED'); }
  const row = rows[0];
  if (rows.length !== 1 || !row || row.dataset !== 'merchant-catalog-v1' ||
      row.square_merchant_id !== expected.squareMerchantId ||
      row.square_location_id !== expected.squareLocationId || row.checkout_enabled !== false ||
      !['unassigned','square','website'].includes(row.inventory_owner)) throw new MerchantImportError('TARGET_UNVERIFIED');
  return row;
}

/** Called only with a newly approved, separate, empty database. Never on the current Railway pilot. */
export async function initializeEmptyMerchantCatalog(db: SqlDatabase, identity: MerchantCatalogIdentity): Promise<void> {
  requireIdentity(identity);
  const sql = await readFile(new URL('../../db/merchant-catalog-bootstrap.sql', import.meta.url), 'utf8');
  await db.transaction(async tx => {
    const schemas = await tx.query<{ schema_name: string }>(
      "SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('public','information_schema') AND left(schema_name,3)<>'pg_'");
    const relations = await tx.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
    if (schemas.rows.length || relations.rows.length) throw new MerchantImportError('NOT_EMPTY');
    await tx.exec(sql);
    await tx.query(
      "INSERT INTO merchant_catalog_identity(singleton,dataset,square_merchant_id,square_location_id,inventory_owner,checkout_enabled) VALUES (true,'merchant-catalog-v1',$1,$2,'unassigned',false)",
      [identity.squareMerchantId, identity.squareLocationId]);
  });
}

function validatePlan(raw: unknown): MerchantImportPlan {
  if (!plain(raw) || !id(raw.squareMerchantId, 192) || !id(raw.squareLocationId, 64) ||
      (raw.taxTreatment !== undefined && raw.taxTreatment !== 'square-order-authoritative') ||
      !ownerValid(raw.inventoryOwner) || !Number.isSafeInteger(raw.reviewHolds) ||
      (raw.reviewHolds as number) < 0 || (raw.reviewHolds as number) > 250 ||
      !plain(raw.catalog) || !Array.isArray(raw.sourceLinks)) throw new MerchantImportError('PREVIEW_INVALID');
  const plan = raw as unknown as MerchantImportPlan;
  if (plan.catalog.currency !== 'USD' || !Array.isArray(plan.catalog.products) ||
      !plan.catalog.products.length || plan.catalog.products.length > 75 ||
      plan.catalog.products.some(p => p.variants.length > 25) ||
      plan.catalog.products.reduce((count, p) => count + p.variants.length, 0) > 250)
    throw new MerchantImportError('PREVIEW_INVALID');
  try { validateCatalog(plan.catalog); } catch { throw new MerchantImportError('PREVIEW_INVALID'); }
  if (plan.sourceLinks.length !== plan.catalog.products.length) throw new MerchantImportError('PREVIEW_INVALID');
  const pById = new Map<string, Product>((plan.catalog.products as readonly Product[]).map((p: Product) => [p.id, p]));
  const seenItemIds = new Set<string>(), seenVarIds = new Set<string>();
  for (const link of plan.sourceLinks) {
    if (!plain(link) || !id(link.squareItemId, 192) ||
        seenItemIds.has(link.squareItemId) ||
        link.productId !== squareProductId('item', link.squareItemId) || !Array.isArray(link.variants))
      throw new MerchantImportError('PREVIEW_INVALID');
    seenItemIds.add(link.squareItemId);
    const product = pById.get(link.productId);
    if (!product || link.variants.length !== product.variants.length) throw new MerchantImportError('PREVIEW_INVALID');
    const localIds = new Set<string>((product.variants as readonly Variant[]).map((v: Variant) => v.id));
    for (const mapping of link.variants) {
      if (!plain(mapping) || !id(mapping.squareVariationId, 192) ||
          mapping.variantId !== squareProductId('variation', mapping.squareVariationId) ||
          seenVarIds.has(mapping.squareVariationId) || !localIds.has(mapping.variantId))
        throw new MerchantImportError('PREVIEW_INVALID');
      seenVarIds.add(mapping.squareVariationId);
    }
  }
  for (const product of plan.catalog.products) for (const variant of product.variants) {
    if (variant.stockQuantity !== 0 || variant.enabled !== false) throw new MerchantImportError('PREVIEW_INVALID');
  }
  return plan;
}

/** A preview is never trusted merely because it has the right TypeScript type. */
export function reviewedMerchantImportPlan(
  preview: SquareCatalogPreview, identity: MerchantCatalogIdentity, inventoryOwner: InventoryOwner,
  options: SquareCatalogImportOptions = {},
): { plan: MerchantImportPlan; fingerprint: string } {
  requireIdentity(identity);
  if (!ownerValid(inventoryOwner) || !plain(preview) || !(preview.mode === 'sandbox-read-only'||preview.mode === 'production-read-only'&&options.environment==='production') ||
      !Array.isArray(preview.candidates) || !plain(preview.draft) || !Array.isArray(preview.draft.products) ||
      !Number.isSafeInteger(preview.pages) || preview.pages < 1 || preview.pages > 5 ||
      !Number.isSafeInteger(preview.objectsSeen) || preview.objectsSeen < 0 || preview.objectsSeen > 450 ||
      preview.candidates.length > 250 || preview.held !== preview.candidates.filter(c => Array.isArray(c.holds) && c.holds.length > 0).length)
    throw new MerchantImportError('PREVIEW_INVALID');
  const allowed = (preview.candidates as readonly PreviewCandidate[]).filter((c: PreviewCandidate) => Array.isArray(c.holds) && c.holds.length === 0);
  if (allowed.length === 0) throw new MerchantImportError('NO_ELIGIBLE_PRODUCTS');
  const expected: Product[] = allowed.map((item: PreviewCandidate) => {
    if (!id(item.squareId, 192) || !item.name || !item.description || !item.category ||
        !Array.isArray(item.taxIds) || item.taxIds.some(taxId => !id(taxId, 192)) ||
        (item.taxIds.length > 0 && options.taxTreatment !== 'square-order-authoritative') ||
        !Array.isArray(item.modifierListIds) || item.modifierListIds.length || !Array.isArray(item.variations) ||
        item.variations.some((v: PreviewVariation) => !id(v.squareId, 192))) throw new MerchantImportError('PREVIEW_INVALID');
    return {
      id: squareProductId('item', item.squareId), name: item.name,
      description: item.description, category: item.category,
      options: item.variations.length > 1 ? [{ id: 'variation', label: 'Variation', values: item.variations.map((v: PreviewVariation) => v.name) }] : [],
      variants: item.variations.map((v: PreviewVariation) => ({
        id: squareProductId('variation', v.squareId), sku: v.sku,
        selections: item.variations.length > 1 ? { variation: v.name } as Record<string,string> : {} as Record<string,string>,
        priceMinor: v.priceMinor, stockQuantity: 0, enabled: false,
      })),
    };
  });
  const normalizedExpected = { currency: 'USD' as const, products: expected };
  // The exact immutable catalog must agree with the provider-derived source IDs and values.
  if (digest(preview.draft) !== digest(normalizedExpected)) throw new MerchantImportError('PREVIEW_INVALID');
  const links: SquareImportLink[] = allowed.map((item: PreviewCandidate) => ({
    squareItemId: item.squareId,
    productId: squareProductId('item', item.squareId),
    variants: item.variations.map((v: PreviewVariation) => ({
      squareVariationId: v.squareId, variantId: squareProductId('variation', v.squareId),
    })),
  }));
  const plan = validatePlan({
    ...(options.taxTreatment === 'square-order-authoritative' ? { taxTreatment: options.taxTreatment } : {}),
    squareMerchantId: identity.squareMerchantId, squareLocationId: identity.squareLocationId,
    inventoryOwner, reviewHolds: preview.held, catalog: normalizedExpected, sourceLinks: links,
  });
  return { plan, fingerprint: digest(plan) };
}

type ImportBatch = { fingerprint: string; square_merchant_id: string; square_location_id: string;
  requested_inventory_owner: string; plan: MerchantImportPlan; state: 'staged' | 'committed' };
function stageResult(row: ImportBatch, reused: boolean): MerchantStageResult {
  const plan = validatePlan(row.plan);
  return {
    fingerprint: row.fingerprint, state: row.state, reused,
    reviewHolds: plan.reviewHolds, productCount: plan.catalog.products.length,
    variantCount: (plan.catalog.products as readonly Product[]).reduce((sum: number, p: Product) => sum + p.variants.length, 0),
    inventoryOwner: plan.inventoryOwner, checkoutEnabled: false,
  };
}
export interface MerchantImportReview extends MerchantStageResult {
  readonly products: readonly { readonly squareItemId: string; readonly name: string;
    readonly category: string; readonly variations: readonly { readonly squareVariationId: string;
      readonly sku: string; readonly priceMinor: number; readonly stockQuantity: 0; readonly enabled: false }[] }[];
  readonly note: 'Review only. No checkout or stock activation.';
}
export interface MerchantImportStatus {
  readonly mode: 'fresh-merchant-database'; readonly checkoutEnabled: false;
  readonly inventoryOwner: 'unassigned' | InventoryOwner; readonly productCount: number;
  readonly batches: readonly { readonly fingerprint: string; readonly state: 'staged' | 'committed';
    readonly inventoryOwner: InventoryOwner; readonly productCount: number }[];
}
function importReview(row: ImportBatch, reused = false): MerchantImportReview {
  const plan = validatePlan(row.plan);
  const byId = new Map(plan.catalog.products.map(p => [p.id, p]));
  return {
    ...stageResult(row, reused),
    products: plan.sourceLinks.map(link => {
      const product = byId.get(link.productId)!;
      const variants = new Map(product.variants.map(v => [v.id, v]));
      return {
        squareItemId: link.squareItemId, name: product.name, category: product.category,
        variations: link.variants.map(mapping => {
          const variant = variants.get(mapping.variantId)!;
          return { squareVariationId: mapping.squareVariationId,
            sku: variant.sku, priceMinor: variant.priceMinor, stockQuantity: 0 as const, enabled: false as const };
        }),
      };
    }),
    note: 'Review only. No checkout or stock activation.',
  };
}
export class MerchantCatalogImportStore {
  constructor(private readonly db: SqlDatabase, private readonly options: SquareCatalogImportOptions = {}) {}

  /** Read-only merchant marker and recent stage receipts. Synthetic databases fail closed. */
  async status(identity: MerchantCatalogIdentity): Promise<MerchantImportStatus> {
    requireIdentity(identity);
    return this.db.transaction(async tx => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const marker = await identityRow(tx, identity);
      const products = await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM catalog_products');
      const batches = await tx.query<Pick<ImportBatch,'fingerprint'|'state'|'requested_inventory_owner'|'plan'>>(
        'SELECT fingerprint,state,requested_inventory_owner,plan FROM merchant_catalog_import_batches ORDER BY created_at DESC,fingerprint LIMIT 10');
      return {
        mode: 'fresh-merchant-database' as const, checkoutEnabled: false as const,
        inventoryOwner: marker.inventory_owner as MerchantImportStatus['inventoryOwner'],
        productCount: products.rows[0]?.count ?? 0,
        batches: batches.rows.map(row => ({
          fingerprint: row.fingerprint, state: row.state,
          inventoryOwner: validatePlan(row.plan).inventoryOwner,
          productCount: validatePlan(row.plan).catalog.products.length,
        })),
      };
    });
  }

  /** Persisted exact review snapshot; GET cannot modify or recalculate source data. */
  async inspect(fingerprint: string, identity: MerchantCatalogIdentity): Promise<MerchantImportReview> {
    requireIdentity(identity);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new MerchantImportError('REVIEW_REQUIRED');
    return this.db.transaction(async tx => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await identityRow(tx, identity);
      const fetched = await tx.query<ImportBatch>(
        'SELECT fingerprint,square_merchant_id,square_location_id,requested_inventory_owner,plan,state FROM merchant_catalog_import_batches WHERE fingerprint=$1', [fingerprint]);
      const row = fetched.rows[0];
      if (!row) throw new MerchantImportError('STAGE_NOT_FOUND');
      if (row.square_merchant_id !== identity.squareMerchantId ||
          row.square_location_id !== identity.squareLocationId ||
          digest(validatePlan(row.plan)) !== fingerprint) throw new MerchantImportError('FINGERPRINT_MISMATCH');
      return importReview(row);
    });
  }

  /** Stage only metadata + disabled draft. Never alters stock, products, or state ownership. */
  async stage(preview: SquareCatalogPreview, identity: MerchantCatalogIdentity,
    inventoryOwner: InventoryOwner): Promise<MerchantStageResult> {
    const { plan, fingerprint } = reviewedMerchantImportPlan(preview, identity, inventoryOwner, this.options);
    return this.db.transaction(async tx => {
      const marker = await identityRow(tx, identity, true);
      if (marker.inventory_owner !== 'unassigned' && marker.inventory_owner !== inventoryOwner)
        throw new MerchantImportError('IMPORT_CONFLICT');
      const result = await tx.query(
        "INSERT INTO merchant_catalog_import_batches(fingerprint,square_merchant_id,square_location_id,requested_inventory_owner,plan) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (fingerprint) DO NOTHING RETURNING fingerprint",
        [fingerprint, identity.squareMerchantId, identity.squareLocationId, inventoryOwner, JSON.stringify(plan)]);
      const fetched = await tx.query<ImportBatch>(
        'SELECT fingerprint,square_merchant_id,square_location_id,requested_inventory_owner,plan,state FROM merchant_catalog_import_batches WHERE fingerprint=$1',
        [fingerprint]);
      const row = fetched.rows[0];
      if (!row || digest(validatePlan(row.plan)) !== fingerprint ||
          row.square_merchant_id !== identity.squareMerchantId ||
          row.square_location_id !== identity.squareLocationId || row.requested_inventory_owner !== inventoryOwner)
        throw new MerchantImportError('FINGERPRINT_MISMATCH');
      return stageResult(row, result.rows.length === 0);
    });
  }

  /** Exact fingerprint + explicit review acknowledgement. One approved initial import; no upserts. */
  async commit(fingerprint: string, identity: MerchantCatalogIdentity, actorId: string,
    approval: 'approve-disabled-merchant-import-v1'): Promise<MerchantStageResult> {
    requireIdentity(identity);
    if (!/^[a-f0-9]{64}$/.test(fingerprint) || !id(actorId, 128) ||
        approval !== 'approve-disabled-merchant-import-v1') throw new MerchantImportError('REVIEW_REQUIRED');
    return this.db.transaction(async tx => {
      const marker = await identityRow(tx, identity, true);
      const found = await tx.query<ImportBatch>(
        'SELECT fingerprint,square_merchant_id,square_location_id,requested_inventory_owner,plan,state FROM merchant_catalog_import_batches WHERE fingerprint=$1 FOR UPDATE',
        [fingerprint]);
      const row = found.rows[0];
      if (!row) throw new MerchantImportError('STAGE_NOT_FOUND');
      const plan = validatePlan(row.plan);
      if (digest(plan) !== fingerprint || row.square_merchant_id !== identity.squareMerchantId ||
          row.square_location_id !== identity.squareLocationId ||
          row.requested_inventory_owner !== plan.inventoryOwner)
        throw new MerchantImportError('FINGERPRINT_MISMATCH');
      if (row.state === 'committed') return stageResult(row, true);
      if (row.state !== 'staged' || marker.inventory_owner !== 'unassigned')
        throw new MerchantImportError('IMPORT_CONFLICT');
      const any = await tx.query<{ count: number }>(
        'SELECT (SELECT count(*) FROM catalog_products) + (SELECT count(*) FROM catalog_variants) + (SELECT count(*) FROM merchant_square_item_links) + (SELECT count(*) FROM merchant_square_variation_links) AS count');
      if (Number(any.rows[0]?.count) !== 0) throw new MerchantImportError('IMPORT_CONFLICT');
      // An all-or-nothing first import. Any SKU/ID collision rolls back every row.
      for (const product of plan.catalog.products) {
        await tx.query('INSERT INTO catalog_products(id,name,description,category,options) VALUES ($1,$2,$3,$4,$5::jsonb)',
          [product.id, product.name, product.description, product.category, JSON.stringify(product.options)]);
        for (const variant of product.variants) {
          await tx.query('INSERT INTO catalog_variants(id,product_id,sku,selections,currency,price_minor,stock_quantity,enabled) VALUES ($1,$2,$3,$4::jsonb,$5,$6,0,false)',
            [variant.id, product.id, variant.sku, JSON.stringify(variant.selections), 'USD', variant.priceMinor]);
        }
      }
      for (const mapping of plan.sourceLinks) {
        await tx.query('INSERT INTO merchant_square_item_links(square_item_id,product_id) VALUES ($1,$2)',
          [mapping.squareItemId, mapping.productId]);
        for (const variation of mapping.variants) {
          await tx.query('INSERT INTO merchant_square_variation_links(square_variation_id,variant_id,square_item_id) VALUES ($1,$2,$3)',
            [variation.squareVariationId, variation.variantId, mapping.squareItemId]);
        }
      }
      await tx.query("UPDATE merchant_catalog_identity SET inventory_owner=$1 WHERE singleton=true AND inventory_owner='unassigned'",
        [plan.inventoryOwner]);
      await tx.query("UPDATE merchant_catalog_import_batches SET state='committed',committed_by=$2,committed_at=now() WHERE fingerprint=$1 AND state='staged'",
        [fingerprint, actorId]);
      return stageResult({ ...row, state: 'committed' }, false);
    });
  }
}

