import type { Catalog } from '../../shared/catalog';
import type { DemoQuote, DemoReceipt } from '../../shared/checkout';

export interface CheckoutBackend {
  getCatalog(): Catalog | Promise<Catalog>;
  quote(input: unknown): DemoQuote | Promise<DemoQuote>;
  checkout(input: unknown): Promise<DemoReceipt>;
}
