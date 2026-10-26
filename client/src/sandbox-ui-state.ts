import { validAttemptId, type CheckoutRequest, type DemoReceipt } from '../../shared/checkout';
import type { SandboxCheckoutState, SandboxCheckoutView } from '../../shared/sandbox-checkout';

const knownStates: readonly string[] = ['reserved', 'order_sending', 'order_ready', 'payment_sending', 'pending', 'completed', 'failed', 'review'];

/** A reload must first reconcile the exact saved attempt, not offer a new payment identity. */
export function verifySandboxStatus(value: unknown, request: CheckoutRequest): SandboxCheckoutView {
  const view = value as Partial<SandboxCheckoutView> | null;
  if (!view || typeof view !== 'object' || view.mode !== 'square-sandbox' ||
      view.attemptId !== request.attemptId || !validAttemptId(view.checkoutId) ||
      view.amountMinor !== request.expectedTotalMinor || view.currency !== 'USD' ||
      view.fulfillment !== 'pickup' || view.fulfillmentAuthorized !== false ||
      typeof view.requiresReconciliation !== 'boolean' ||
      !knownStates.includes(String(view.state)) ||
      (view.orderId != null && typeof view.orderId !== 'string') ||
      (view.paymentId != null && typeof view.paymentId !== 'string') ||
      typeof view.refundedMinor !== 'number' || !Number.isSafeInteger(view.refundedMinor) || view.refundedMinor < 0) {
    throw new Error('Sandbox status does not match the saved checkout. Preserve this attempt for review.');
  }
  return view as SandboxCheckoutView;
}

export function sandboxMayTokenize(state: SandboxCheckoutState | undefined): boolean {
  return state === 'reserved' || state === 'order_ready';
}

export function checkoutFinished(mock: DemoReceipt | undefined, sandbox: SandboxCheckoutView | undefined): boolean {
  return Boolean(mock) || sandbox?.state === 'completed';
}

export function sandboxCardTarget(reactId: string): string {
  return 'sandbox-card-' + reactId.replace(/[^A-Za-z0-9_-]/g, '');
}
