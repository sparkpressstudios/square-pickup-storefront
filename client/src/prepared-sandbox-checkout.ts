import { parseCheckoutRequest, validAttemptId, type CheckoutRequest } from '../../shared/checkout';
import { SandboxCheckoutError, type SandboxCheckoutPort, type SandboxCheckoutView } from '../../shared/sandbox-checkout';
import type { attachSandboxCard, SandboxBillingContact } from './square-tokenization';

interface InjectedCardCheckout {
  execution: 'injected-test-transport' | 'sandbox-only'; port: SandboxCheckoutPort;
  card: Pick<Awaited<ReturnType<typeof attachSandboxCard>>, 'tokenize'>;
}
function checkedView(view: SandboxCheckoutView, request: CheckoutRequest, execution: InjectedCardCheckout['execution']): SandboxCheckoutView {
  if (view?.mode !== (execution === 'sandbox-only' ? 'square-sandbox' : 'mocked-sandbox-protocol') || view.attemptId !== request.attemptId || !validAttemptId(view.checkoutId) || !['reserved','order_sending','order_ready','payment_sending','pending','completed','failed','review'].includes(view.state) || typeof view.requiresReconciliation !== 'boolean' || view.amountMinor !== request.expectedTotalMinor || view.amountMinor < 1 || view.currency !== 'USD' || view.fulfillment !== 'pickup' || view.fulfillmentAuthorized !== false) throw new SandboxCheckoutError('RECONCILIATION_REQUIRED', 'Prepared checkout context changed. Review the same attempt before continuing.');
  return view;
}
/** No default network, SDK loader or browser storage. The caller retains the exact request identity, never the card token. */
export function preparedSandboxCardCheckout(dependencies?: InjectedCardCheckout) {
  let inFlight: Promise<SandboxCheckoutView> | undefined; let identity: string | undefined;
  return {
    async pay(input: CheckoutRequest, billingContact: SandboxBillingContact): Promise<SandboxCheckoutView> {
      if (!dependencies || !['injected-test-transport','sandbox-only'].includes(dependencies.execution)) throw new SandboxCheckoutError('PROVIDERS_DISABLED', 'Sandbox card checkout is disabled.');
      const request = parseCheckoutRequest(input); const key = JSON.stringify(request);
      if (inFlight) { if (identity !== key) throw new Error('Another checkout identity is in progress.'); return inFlight; }
      identity = key;
      inFlight = (async () => {
        const prepared = checkedView(await dependencies.port.prepare(request), request, dependencies.execution);
        if (!['reserved','order_ready'].includes(prepared.state)) return prepared;
        let cardToken: string;
        try { cardToken = await dependencies.card.tokenize(prepared.amountMinor, billingContact); }
        catch {
          // Atomic cancellation can release only a reservation that has never dispatched an order.
          try { await dependencies.port.cancelBeforeDispatch(request); } catch { /* Preserve identity; no unsafe retry or assumption of release. */ }
          throw new Error('Card tokenization did not complete. Keep this checkout identity for status review.');
        }
        try {
          const result = checkedView(await dependencies.port.submit(request, cardToken), request, dependencies.execution);
          if (result.checkoutId !== prepared.checkoutId) throw new Error('Checkout identity changed');
          return result;
        }
        catch { throw new SandboxCheckoutError('RECONCILIATION_REQUIRED', 'Checkout response was not received. Keep the same attempt; review its status before continuing.'); }
      })();
      try { return await inFlight; } finally { inFlight = undefined; identity = undefined; }
    },
  };
}
