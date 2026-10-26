import type { Catalog } from '../shared/catalog';

/** Synthetic catalog authored for this starter; never imported from a merchant. */
export const demoCatalog: Catalog = {
  currency: 'USD',
  products: [
    {
      id: 'studio-candle',
      name: 'Studio candle',
      description: 'A quiet glow, poured in a reusable vessel. Explore two scents and two finishes.',
      category: 'Candles',
      options: [
        { id: 'scent', label: 'Scent', values: ['Cedar', 'Sage'] },
        { id: 'vessel', label: 'Vessel', values: ['Amber', 'Chalk'] },
      ],
      variants: [
        { id: 'candle-cedar-amber', sku: 'DEMO-C-CA', selections: { scent: 'Cedar', vessel: 'Amber' }, priceMinor: 2400, stockQuantity: 7, enabled: true },
        { id: 'candle-sage-amber', sku: 'DEMO-C-SA', selections: { scent: 'Sage', vessel: 'Amber' }, priceMinor: 2400, stockQuantity: 0, enabled: true },
        { id: 'candle-cedar-chalk', sku: 'DEMO-C-CC', selections: { scent: 'Cedar', vessel: 'Chalk' }, priceMinor: 2800, stockQuantity: 4, enabled: true },
        { id: 'candle-sage-chalk', sku: 'DEMO-C-SC', selections: { scent: 'Sage', vessel: 'Chalk' }, priceMinor: 2800, stockQuantity: 2, enabled: false },
      ],
    },
    {
      id: 'ceramic-tray',
      name: 'Ceramic catchall',
      description: 'A simple resting place for keys, rings, and the little things you keep close.',
      category: 'Accessories',
      options: [{ id: 'finish', label: 'Finish', values: ['Sand', 'Olive'] }],
      variants: [
        { id: 'tray-sand', sku: 'DEMO-T-S', selections: { finish: 'Sand' }, priceMinor: 1800, stockQuantity: 9, enabled: true },
        { id: 'tray-olive', sku: 'DEMO-T-O', selections: { finish: 'Olive' }, priceMinor: 2000, stockQuantity: 3, enabled: true },
      ],
    },
    {
      id: 'wick-trimmer',
      name: 'Wick trimmer',
      description: 'A small tool for a well-kept candle. Made for the everyday ritual.',
      category: 'Accessories',
      options: [],
      variants: [{ id: 'trimmer-brass', sku: 'DEMO-W-B', selections: {}, priceMinor: 1600, stockQuantity: 1, enabled: true }],
    },
    {
      id: 'pantry-granola',
      name: 'Pantry granola',
      description: 'A fictional pantry staple to show that food uses the same product and variant core.',
      category: 'Pantry',
      options: [{ id: 'blend', label: 'Blend', values: ['Maple', 'Cocoa'] }],
      variants: [
        { id: 'granola-maple', sku: 'DEMO-G-M', selections: { blend: 'Maple' }, priceMinor: 800, stockQuantity: 6, enabled: true },
        { id: 'granola-cocoa', sku: 'DEMO-G-C', selections: { blend: 'Cocoa' }, priceMinor: 900, stockQuantity: 5, enabled: true },
      ],
    },
  ],
};
