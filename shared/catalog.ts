export const supportedCurrency = 'USD' as const;

export interface ProductOption {
  readonly id: string;
  readonly label: string;
  readonly values: readonly string[];
}

export interface Variant {
  readonly id: string;
  readonly sku: string;
  readonly selections: Readonly<Record<string, string>>;
  readonly priceMinor: number;
  readonly stockQuantity: number;
  readonly enabled: boolean;
}

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly options: readonly ProductOption[];
  readonly variants: readonly Variant[];
}

export interface Catalog {
  readonly currency: typeof supportedCurrency;
  readonly products: readonly Product[];
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid catalog: ${message}`);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function validId(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** Validate trusted repository data at the boundary before exposing a snapshot. */
export function validateCatalog(catalog: Catalog): void {
  requireValue(catalog.currency === supportedCurrency, 'only USD is supported');
  requireValue(unique(catalog.products.map((p) => p.id)), 'duplicate product IDs');
  const allVariants = catalog.products.flatMap((p) => p.variants);
  requireValue(unique(allVariants.map((v) => v.id)), 'duplicate variant IDs');
  requireValue(unique(allVariants.map((v) => v.sku)), 'duplicate SKUs');

  for (const product of catalog.products) {
    requireValue(validId(product.id), 'invalid product ID');
    requireValue(product.name.trim() && product.description.trim() && product.category.trim(), 'blank product fields');
    requireValue(unique(product.options.map((o) => o.id)), 'duplicate option IDs');
    for (const option of product.options) {
      requireValue(validId(option.id) && option.label.trim(), 'invalid option definition');
      requireValue(option.values.length > 0 && unique(option.values), 'empty or duplicate option values');
      requireValue(option.values.every((value) => typeof value === 'string' && value.trim()), 'blank option value');
    }
    requireValue(product.variants.length > 0, 'product has no variants');
    const combinations: string[] = [];
    for (const variant of product.variants) {
      requireValue(validId(variant.id) && variant.sku.trim(), 'invalid variant identity');
      requireValue(Number.isSafeInteger(variant.priceMinor) && variant.priceMinor >= 0 && variant.priceMinor <= 2_147_483_647, 'price must be nonnegative integer minor units');
      requireValue(Number.isSafeInteger(variant.stockQuantity) && variant.stockQuantity >= 0 && variant.stockQuantity <= 2_147_483_647, 'stock must be a nonnegative integer');
      requireValue(typeof variant.enabled === 'boolean', 'variant enabled must be boolean');
      requireValue(Object.keys(variant.selections).length === product.options.length, 'variant option count mismatch');
      for (const option of product.options) {
        requireValue(Object.hasOwn(variant.selections, option.id) && option.values.includes(variant.selections[option.id]!), 'unknown or missing variant option value');
      }
      combinations.push(JSON.stringify(product.options.map((o) => variant.selections[o.id])));
    }
    requireValue(unique(combinations), 'duplicate option combinations');
  }
}

export function resolveVariant(product: Product, selections: Readonly<Record<string, string>>): Variant | undefined {
  if (Object.keys(selections).length !== product.options.length) return undefined;
  if (!product.options.every((o) => Object.hasOwn(selections, o.id) && o.values.includes(selections[o.id]!))) return undefined;
  return product.variants.find((variant) => product.options.every((o) => variant.selections[o.id] === selections[o.id]));
}

export function variantAvailability(variant: Variant | undefined): 'available' | 'sold_out' | 'unavailable' {
  if (!variant?.enabled) return 'unavailable';
  return variant.stockQuantity > 0 ? 'available' : 'sold_out';
}

export function formatPrice(priceMinor: number, currency: typeof supportedCurrency): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(priceMinor / 100);
}
