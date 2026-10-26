import type { SandboxIntent } from './square-sandbox';
import { squareApiVersion } from './square-sandbox';
import type { SquareCatalogPreviewConfig } from './square-catalog-readonly';

/**
 * Standalone, provider-calculated tax quote preview for trusted synthetic cart intents.
 * It does not create an order, reserve inventory, process payments, or change checkout totals.
 */
export class SquareTotalsPreviewError extends Error {
  constructor(readonly code: 'CONFIGURATION' | 'QUOTE_MISMATCH' | 'REMOTE_ERROR' | 'UNVERIFIED_TOTAL') { super(code); }
}
export interface SquareCalculatedTotals {
  readonly currency: 'USD'; readonly subtotalMinor: number; readonly taxMinor: number;
  readonly totalMinor: number; readonly requiresCheckoutIntegration: true;
  readonly productionChargeAuthorized: false; readonly provider: 'square-sandbox-calculate-order';
}
function money(object: unknown, optional = false): number | null {
  if (optional && object === undefined) return 0;
  const data = object !== null && typeof object === 'object' && !Array.isArray(object) ? object as Record<string, unknown> : {};
  return data.currency === 'USD' && typeof data.amount === 'number' && Number.isSafeInteger(data.amount) && data.amount >= 0 && data.amount <= 2_147_483_647 ? data.amount : null;
}
export async function previewSquareSandboxTotals(intent: SandboxIntent, config: SquareCatalogPreviewConfig, fetcher: typeof fetch): Promise<SquareCalculatedTotals> {
  if (config.environment !== 'sandbox' || !/^\S{16,}$/.test(config.token) ||
      !/^[A-Za-z0-9]{1,64}$/.test(config.locationId) || typeof fetcher !== 'function')
    throw new SquareTotalsPreviewError('CONFIGURATION');
  const quote = intent?.quote;
  if (typeof intent?.checkoutId !== 'string' || !quote || quote.currency !== 'USD' || quote.fulfillment !== 'pickup' ||
      quote.pricing !== 'demo-subtotal-only' || !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor < 1 || quote.totalMinor > 2_147_483_647 ||
      !quote.lines.length || quote.lines.length > 50) throw new SquareTotalsPreviewError('QUOTE_MISMATCH');
  let subtotal = 0;
  for (const line of quote.lines) {
    if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 99 ||
        !Number.isSafeInteger(line.unitPriceMinor) || line.unitPriceMinor < 0 ||
        !line.name || line.name.length > 512 || line.lineTotalMinor !== line.quantity * line.unitPriceMinor)
      throw new SquareTotalsPreviewError('QUOTE_MISMATCH');
    subtotal += line.lineTotalMinor;
  }
  if (subtotal !== quote.totalMinor) throw new SquareTotalsPreviewError('QUOTE_MISMATCH');
  const order = {
    location_id: config.locationId,
    line_items: quote.lines.map(line => ({
      name: line.name, quantity: String(line.quantity),
      base_price_money: { amount: line.unitPriceMinor, currency: 'USD' },
    })),
    pricing_options: { auto_apply_taxes: true, auto_apply_discounts: false },
  };
  let response: Response;
  try {
    response = await fetcher('https://connect.squareupsandbox.com/v2/orders/calculate', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Authorization: 'Bearer ' + config.token, 'Square-Version': squareApiVersion,
        'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ order }),
    });
  } catch { throw new SquareTotalsPreviewError('REMOTE_ERROR'); }
  if (response.status !== 200) throw new SquareTotalsPreviewError('REMOTE_ERROR');
  if (Number(response.headers.get('content-length') ?? 0) > 128 * 1024) throw new SquareTotalsPreviewError('REMOTE_ERROR');
  let raw: string;
  try {
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    let count = 0; const parts: Uint8Array[] = [];
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; count += next.value.byteLength;
        if (count > 128 * 1024) throw new Error(); parts.push(next.value); }
    } finally { await reader.cancel().catch(() => {}); }
    raw = Buffer.concat(parts).toString('utf8');
  } catch { throw new SquareTotalsPreviewError('REMOTE_ERROR'); }
  let result: Record<string, unknown>;
  try { result = JSON.parse(raw); } catch { throw new SquareTotalsPreviewError('UNVERIFIED_TOTAL'); }
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.errors !== undefined) throw new SquareTotalsPreviewError('UNVERIFIED_TOTAL');
  const data = result.order !== null && typeof result.order === 'object' && !Array.isArray(result.order) ? result.order as Record<string, unknown> : {};
  const total = money(data.total_money), tax = money(data.total_tax_money, true);
  const discounts = money(data.total_discount_money, true), charges = money(data.total_service_charge_money, true);
  const gross = money(data.gross_sales_money, true);
  if (data.location_id !== config.locationId || total === null || tax === null ||
      discounts !== 0 || charges !== 0 || gross === null || (gross !== 0 && gross !== subtotal) ||
      total !== subtotal + tax || total < 1) throw new SquareTotalsPreviewError('UNVERIFIED_TOTAL');
  return { currency: 'USD', subtotalMinor: subtotal, taxMinor: tax, totalMinor: total,
    requiresCheckoutIntegration: true, productionChargeAuthorized: false, provider: 'square-sandbox-calculate-order' };
}
