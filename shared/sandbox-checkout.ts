import type { CheckoutRequest } from './checkout';

export type SandboxCheckoutState = 'reserved' | 'order_sending' | 'order_ready' | 'payment_sending' | 'pending' | 'completed' | 'failed' | 'review';
export interface SandboxCheckoutView {
  readonly mode: 'mocked-sandbox-protocol' | 'square-sandbox'; readonly attemptId: string; readonly checkoutId: string; readonly refundedMinor: number;
  readonly state: SandboxCheckoutState; readonly amountMinor: number; readonly currency: 'USD'; readonly fulfillment: 'pickup';
  readonly orderId: string | null; readonly paymentId: string | null; readonly failureCode: string | null;
  readonly requiresReconciliation: boolean; readonly fulfillmentAuthorized: false;
}
/** Explicit injected test bridge; no HTTP endpoint, default fetch, credentials or card-token persistence. */
export interface SandboxCheckoutPort {
  prepare(request: CheckoutRequest): Promise<SandboxCheckoutView>;
  submit(request: CheckoutRequest, cardToken: string): Promise<SandboxCheckoutView>;
  cancelBeforeDispatch(request: CheckoutRequest): Promise<SandboxCheckoutView>;
}
export class SandboxCheckoutError extends Error {
  constructor(readonly code: 'PROVIDERS_DISABLED' | 'INVALID_CARD_TOKEN' | 'RECONCILIATION_REQUIRED' | 'PERSISTENCE_UNAVAILABLE', message: string) { super(message); }
}
