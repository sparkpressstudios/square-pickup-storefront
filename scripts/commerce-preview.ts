/**
 * Explicit opt-in, private Railway / developer CLI. Never mounted as a public API,
 * and never run as a startup job or an automated recurring synchronization.
 */
import { randomUUID } from 'node:crypto';
import { previewConfiguration, previewSquareSandboxCatalog, SquareCatalogPreviewError } from '../server/src/square-catalog-readonly';
import { previewSquareSandboxTotals, SquareTotalsPreviewError } from '../server/src/square-totals-preview';
import { sandboxIntent } from '../server/src/square-sandbox';
import { demoCatalog } from '../config/demo-catalog';

const mode = process.argv[2];
if (!['--catalog', '--tax-preview', '--both'].includes(mode) || process.argv.length !== 3) {
  console.error('Usage: pnpm exec tsx scripts/commerce-preview.ts --catalog|--tax-preview|--both');
  process.exitCode = 2;
} else {
  void (async () => {
    try {
      if (process.env.RAILWAY_ENVIRONMENT_NAME && process.env.RAILWAY_ENVIRONMENT_NAME !== 'sandbox')
        throw new SquareCatalogPreviewError('SANDBOX_CONFIGURATION');
      const config = previewConfiguration(process.env);
      if (mode === '--catalog' || mode === '--both') {
        const preview = await previewSquareSandboxCatalog(config, fetch);
        console.log('Square read-only catalog preview: pages=' + preview.pages +
          ' objects=' + preview.objectsSeen + ' items=' + preview.candidates.length +
          ' reviewHolds=' + preview.held + ' safeDisabledDraftProducts=' + preview.draft.products.length);
      }
      if (mode === '--tax-preview' || mode === '--both') {
        const cart = { items: [{ productId: 'studio-candle', variantId: 'candle-cedar-amber', quantity: 1 }], currency: 'USD' as const, fulfillment: 'pickup' as const };
        const intent = sandboxIntent(demoCatalog, cart, randomUUID());
        const totals = await previewSquareSandboxTotals(intent, config, fetch);
        console.log('Square tax calculation preview for synthetic item: subtotalMinor=' + totals.subtotalMinor +
          ' taxMinor=' + totals.taxMinor + ' totalMinor=' + totals.totalMinor);
      }
      console.log('No database, catalog, inventory, customer, order, payment or refund mutation. Production remains disabled.');
    } catch (error) {
      const code = error instanceof SquareCatalogPreviewError || error instanceof SquareTotalsPreviewError ? error.code : 'PREVIEW_FAILED';
      console.error('Read-only commerce preflight did not complete: ' + code + '. Credentials and provider responses withheld.');
      process.exitCode = 1;
    }
  })();
}
