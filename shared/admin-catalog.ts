import type { Product } from './catalog';

export interface ProductEditRequest {
  revision: string;
  name: string;
  description: string;
  category: string;
  variants: { id: string; priceMinor: number; stockQuantity: number; enabled: boolean }[];
}
export interface EditableProduct { product: Product; revision: string }
export class AdminError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new AdminError(400, 'INVALID_PRODUCT', 'Use valid product fields, integer prices and stock, and the existing variant IDs.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) invalid();
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value.trim();
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) invalid();
  return value;
}
/** Adapted explicit-field update pattern; identities/options are deliberately immutable here. */
export function parseProductEdit(value: unknown): ProductEditRequest {
  const input = record(value);
  fields(input, ['revision', 'name', 'description', 'category', 'variants']);
  if (typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision)) invalid();
  if (!Array.isArray(input.variants) || input.variants.length < 1 || input.variants.length > 100) invalid();
  const variants = input.variants.map((raw) => {
    const variant = record(raw); fields(variant, ['id', 'priceMinor', 'stockQuantity', 'enabled']);
    if (typeof variant.enabled !== 'boolean') invalid();
    return { id: text(variant.id, 100), priceMinor: integer(variant.priceMinor), stockQuantity: integer(variant.stockQuantity), enabled: variant.enabled };
  });
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) invalid();
  return { revision: input.revision, name: text(input.name, 160), description: text(input.description, 2000), category: text(input.category, 80), variants };
}
export function applyProductEdit(product: Product, request: ProductEditRequest): Product {
  if (request.variants.length !== product.variants.length || request.variants.some((variant) => !product.variants.some((existing) => existing.id === variant.id))) invalid();
  return { ...product, name: request.name, description: request.description, category: request.category,
    variants: product.variants.map((variant) => ({ ...variant, ...request.variants.find((edit) => edit.id === variant.id)! })) };
}
