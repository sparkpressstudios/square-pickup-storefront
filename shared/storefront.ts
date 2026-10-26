import type { Catalog } from './catalog';
import type { SandboxPublicConfig } from './square-sandbox';

export interface MerchantConfig {
  readonly name: string;
  readonly descriptor: string;
  readonly tagline: string;
  readonly introduction: string;
  readonly currency: 'USD';
  readonly fulfillment: 'pickup';
  readonly pickup: { readonly label: string; readonly instructions: string };
  readonly theme: { readonly accent: string; readonly background: string };
  readonly media?: { readonly hero: string; readonly products: Readonly<Record<string, { readonly src: string; readonly position: string; readonly layout?: 'single' | 'atlas' }>> };
}

export interface Storefront {
  readonly sandbox?: SandboxPublicConfig;
  readonly merchant: MerchantConfig;
  readonly catalog: Catalog;
  readonly mode: 'synthetic-demo';
  readonly capabilities: {
    readonly checkout: false;
    readonly mockCheckout: true;
    readonly square: false;
    readonly outboundMail: false;
    readonly schedulers: false;
    readonly databaseConnected: boolean;
  };
}
