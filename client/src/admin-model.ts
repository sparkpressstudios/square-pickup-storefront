import { parseProductEdit, type ProductEditRequest } from '../../shared/admin-catalog';
import type { Product } from '../../shared/catalog';

/** Longest matching navigation item, adapted from Urban Churn AdminLayout. */
export function activeAdminHref(location: string, hrefs: readonly string[], root: string): string | undefined {
  if (location === root) return root;
  return hrefs.filter((href) => href !== root && (location === href || location.startsWith(`${href}/`))).sort((a, b) => b.length - a.length)[0];
}
/** Product search and variation counts retain the source product-list structure. */
export function filterProducts(products: readonly Product[], search: string): readonly Product[] {
  return products.filter((product) => product.name.toLowerCase().includes(search.toLowerCase()));
}
export function catalogSummary(products: readonly Product[]) {
  const variants = products.flatMap((product) => product.variants);
  return { products: products.length, variants: variants.length, available: variants.filter((variant) => variant.enabled && variant.stockQuantity > 0).length, soldOut: variants.filter((variant) => variant.enabled && variant.stockQuantity === 0).length };
}
export interface ProductForm {
  name: string; description: string; category: string;
  variants: { id: string; price: string; stock: string; enabled: boolean }[];
}
export function productForm(product: Product): ProductForm {
  return { name: product.name, description: product.description, category: product.category,
    variants: product.variants.map((variant) => ({ id: variant.id, price: (variant.priceMinor / 100).toFixed(2), stock: String(variant.stockQuantity), enabled: variant.enabled })) };
}
/** Exact decimal conversion; no parseFloat rounding/truncation of operator input. */
export function priceMinor(value: string): number {
  if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(value)) throw new Error('Enter a USD price with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount) || amount > 2_147_483_647) throw new Error('Price is too large.');
  return amount;
}
export function formRequest(form: ProductForm, revision: string): ProductEditRequest {
  return parseProductEdit({ revision, name: form.name, description: form.description, category: form.category,
    variants: form.variants.map((variant) => {
      if (!/^(0|[1-9]\d*)$/.test(variant.stock)) throw new Error('Stock must be a nonnegative whole number.');
      return { id: variant.id, priceMinor: priceMinor(variant.price), stockQuantity: Number(variant.stock), enabled: variant.enabled };
    }) });
}
