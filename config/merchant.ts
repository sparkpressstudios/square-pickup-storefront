import type { MerchantConfig } from '../shared/storefront';
import { demoPresentation } from './demo-presentation';

/** Original fictional merchant content. No real location or contact data. */
export const merchant = {
  name: 'Stillroom Supply',
  descriptor: 'Everyday goods, thoughtfully chosen',
  tagline: 'Shop the collection',
  introduction: 'Browse products, choose your options, and add to cart.',
  currency: 'USD',
  fulfillment: 'pickup',
  pickup: {
    label: 'Demo studio pickup',
    instructions: 'A fictional pickup location for this local demo. No orders or reservations are accepted.',
  },
  theme: { accent: '#A1AB74', background: '#f9f8f4' },
  media: demoPresentation,
} as const satisfies MerchantConfig;
