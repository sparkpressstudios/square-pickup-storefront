import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { demoCatalog } from '../../config/demo-catalog';
import * as schema from '../../db/schema/catalog';
import { validateCatalog, type Catalog } from '../../shared/catalog';

export interface CatalogRepository {
  load(): Promise<Catalog>;
}

export const demoRepository: CatalogRepository = {
  async load() { return structuredClone(demoCatalog); },
};

/** Future adapter: injected DB only; no client, connection factory, or startup hook. */
export function postgresCatalogRepository(db: NodePgDatabase<typeof schema>): CatalogRepository {
  return {
    async load() {
      // A transaction gives both reads the same snapshot during concurrent catalog edits.
      return db.transaction(async (tx) => {
        const productRows = await tx.select().from(schema.products).orderBy(schema.products.id);
        const variantRows = await tx.select().from(schema.variants).orderBy(schema.variants.id);
        if (variantRows.some((variant) => variant.currency !== 'USD')) throw new Error('Only USD catalog rows are supported');
        const catalog: Catalog = {
          currency: 'USD',
          products: productRows.map((product) => ({
            ...product,
            variants: variantRows.filter((variant) => variant.productId === product.id).map(({ productId: _productId, currency: _currency, ...variant }) => variant),
          })),
        };
        validateCatalog(catalog);
        return catalog;
      }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
    },
  };
}
