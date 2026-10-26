import { parseCheckoutRequest, type CheckoutRequest } from '../../shared/checkout';
import { SandboxCheckoutError, type SandboxCheckoutPort, type SandboxCheckoutView } from '../../shared/sandbox-checkout';
import { publicSandboxConfiguration, sandboxConfiguration, sandboxIntent, SandboxError, SquareSandboxAdapter, type SandboxServerConfig, type SandboxTransport } from './square-sandbox';
import { PreparedSandboxStore, sandboxCheckoutView } from './prepared-sandbox-store';

export interface SandboxProtocolTestDependencies {
  readonly execution: 'injected-test-transport'; readonly configuration: SandboxServerConfig; readonly transport: SandboxTransport;
}
export interface SandboxRuntimeDependencies { readonly execution: 'sandbox-only'; readonly configuration: SandboxServerConfig; readonly transport: SandboxTransport }
/** Disabled by default; callers must explicitly supply isolated test or sandbox-only dependencies. */
export class PreparedSandboxCheckout implements SandboxCheckoutPort {
  #dependencies?: SandboxProtocolTestDependencies | SandboxRuntimeDependencies;
  constructor(private readonly store: PreparedSandboxStore, dependencies?: SandboxProtocolTestDependencies | SandboxRuntimeDependencies) {
    if (dependencies && (!['injected-test-transport','sandbox-only'].includes(dependencies.execution) || typeof dependencies.transport !== 'function' || (dependencies.execution === 'sandbox-only' && store.mode !== 'square-sandbox'))) throw new SandboxCheckoutError('PROVIDERS_DISABLED', 'Explicit sandbox-only dependencies and storage are required.');
    this.#dependencies = dependencies ? { ...dependencies, configuration: sandboxConfiguration({ SQUARE_ENVIRONMENT: dependencies.configuration.environment, SQUARE_APPLICATION_ID: dependencies.configuration.applicationId, SQUARE_LOCATION_ID: dependencies.configuration.locationId, SQUARE_SANDBOX_ACCESS_TOKEN: dependencies.configuration.accessToken }) } : undefined;
  }
  private enabled(): SandboxProtocolTestDependencies | SandboxRuntimeDependencies {
    if (!this.#dependencies) throw new SandboxCheckoutError('PROVIDERS_DISABLED', 'Sandbox checkout/provider execution is disabled.');
    return this.#dependencies;
  }
  async prepare(input: CheckoutRequest): Promise<SandboxCheckoutView> {
    const dependencies = this.enabled();
    return sandboxCheckoutView(await this.store.reserve(input, publicSandboxConfiguration(dependencies.configuration)));
  }
  async cancelBeforeDispatch(input: CheckoutRequest): Promise<SandboxCheckoutView> {
    const dependencies = this.enabled(); const request = parseCheckoutRequest(input);
    await this.store.reserve(request, publicSandboxConfiguration(dependencies.configuration));
    await this.store.fail(request.attemptId, 'reserved', true);
    return sandboxCheckoutView(await this.store.get(request.attemptId));
  }
  async submit(input: CheckoutRequest, cardToken: string): Promise<SandboxCheckoutView> {
    const dependencies = this.enabled(); const request = parseCheckoutRequest(input);
    if (typeof cardToken !== 'string' || !/^\S{1,512}$/.test(cardToken) || ['CASH','EXTERNAL'].includes(cardToken)) throw new SandboxCheckoutError('INVALID_CARD_TOKEN', 'A tokenized sandbox card is required.');
    let attempt = await this.store.reserve(request, publicSandboxConfiguration(dependencies.configuration));
    if (!['reserved','order_ready'].includes(attempt.state)) return sandboxCheckoutView(attempt);
    const adapter = new SquareSandboxAdapter(dependencies.configuration, dependencies.transport);
    const intent = sandboxIntent(attempt.catalog_snapshot, { items: attempt.request.items, currency: 'USD', fulfillment: 'pickup' }, attempt.checkout_id);
    if (attempt.state === 'reserved') {
      if (!await this.store.claim(request.attemptId, 'order')) return sandboxCheckoutView(await this.store.get(request.attemptId));
      try { await this.store.recordOrder(request.attemptId, await adapter.createOrder(intent)); }
      catch (error) { return this.failure(request.attemptId, 'order_sending', error); }
    }
    attempt = await this.store.get(request.attemptId);
    if (attempt.state !== 'order_ready') return sandboxCheckoutView(attempt);
    // Restore trusted persisted evidence without reissuing CreateOrder after a restart.
    const order = adapter.restoreOrder(intent, attempt.order_evidence!);
    if (!await this.store.claim(request.attemptId, 'payment')) return sandboxCheckoutView(await this.store.get(request.attemptId));
    try { await this.store.recordPayment(request.attemptId, await adapter.createPayment(intent, order, cardToken)); }
    catch (error) { return this.failure(request.attemptId, 'payment_sending', error); }
    return sandboxCheckoutView(await this.store.get(request.attemptId));
  }
  private async failure(id: string, stage: 'order_sending' | 'payment_sending', error: unknown): Promise<SandboxCheckoutView> {
    // Only a definite rejected order before any payment, or an explicit payment decline, releases stock.
    const definite = error instanceof SandboxError && (stage === 'payment_sending' ? error.code === 'DECLINED' : ['REJECTED','AUTHENTICATION','DECLINED'].includes(error.code));
    try { await this.store.fail(id, stage, definite); return sandboxCheckoutView(await this.store.get(id)); }
    catch { throw new SandboxCheckoutError('PERSISTENCE_UNAVAILABLE', 'Checkout outcome could not be recorded. Preserve the attempt and reconcile; do not create another payment identity.'); }
  }
}
