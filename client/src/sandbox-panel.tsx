import { useEffect, useId, useRef, useState } from 'react';
import type { SandboxPublicConfig } from '../../shared/square-sandbox';
import type { CheckoutRequest } from '../../shared/checkout';
import type { SandboxCheckoutView } from '../../shared/sandbox-checkout';
import { attachSandboxCard } from './square-tokenization';
import { preparedSandboxCardCheckout } from './prepared-sandbox-checkout';
import { loadSandboxSdk, sandboxBrowserPort } from './sandbox-browser';
import { sandboxCardTarget, sandboxMayTokenize, verifySandboxStatus } from './sandbox-ui-state';

/** One card widget per checkout screen. Never mount this in the cart drawer. */
export function SandboxPanel({ config, request, onResult }: { config: SandboxPublicConfig; request: CheckoutRequest; onResult: (result: SandboxCheckoutView) => void }) {
  const target = sandboxCardTarget(useId());
  const card = useRef<Awaited<ReturnType<typeof attachSandboxCard>> | null>(null);
  const pending = useRef(false);
  const [status, setStatus] = useState<SandboxCheckoutView>();
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Always check the durable attempt before asking for card details, particularly after a reload.
  useEffect(() => {
    let disposed = false;
    const port = sandboxBrowserPort(config);
    void (async () => {
      setChecking(true); setReady(false); setError('');
      try {
        const view = verifySandboxStatus(await port.prepare(request), request);
        if (disposed) return;
        setStatus(view); onResult(view);
        if (!sandboxMayTokenize(view.state)) return;
        const controller = await attachSandboxCard(config, '#' + target, {
          isSecureContext: window.isSecureContext,
          loadSdk: async (url) => {
            const sdk = await loadSandboxSdk(url);
            if (disposed) throw new Error('Checkout was closed');
            return sdk;
          },
        });
        if (disposed) { await controller.destroy(); return; }
        card.current = controller;
        setReady(true);
      } catch {
        if (!disposed) setError('Unable to prepare the sandbox card. Keep this saved checkout identity and check its status.');
      } finally {
        if (!disposed) setChecking(false);
      }
    })();
    return () => {
      disposed = true;
      const old = card.current;
      card.current = null;
      if (old) void old.destroy().catch(() => {});
    };
  }, [config, request, target, onResult]);

  function applyResult(view: SandboxCheckoutView) {
    const checked = verifySandboxStatus(view, request);
    setStatus(checked);
    onResult(checked);
    return checked;
  }

  function checkStatus() {
    if (pending.current || checking) return;
    pending.current = true; setBusy(true); setError('');
    void sandboxBrowserPort(config).prepare(request)
      .then(applyResult)
      .catch(() => setError('Status could not be retrieved. Keep this same checkout identity; do not start another charge.'))
      .finally(() => { pending.current = false; setBusy(false); });
  }

  function pay() {
    if (pending.current || checking || !card.current || !sandboxMayTokenize(status?.state)) return;
    pending.current = true; setBusy(true); setError('');
    const controller = preparedSandboxCardCheckout({ execution: 'sandbox-only', card: card.current, port: sandboxBrowserPort(config) });
    // Do not send fictional pickup contact details or raw card fields to our server.
    void controller.pay(request, { countryCode: 'US' })
      .then(applyResult)
      .catch(() => setError('Payment outcome could not be confirmed. Check this exact attempt status before any further action.'))
      .finally(() => { pending.current = false; setBusy(false); });
  }

  const canPay = sandboxMayTokenize(status?.state);
  return <section className="sandbox-card-test" aria-label="Square sandbox card test">
    <h3>Square sandbox card test</h3>
    <p>Use a Square sandbox test card only. This makes a simulated Square payment, not a real charge. Pickup fulfillment is never authorized.</p>
    <div id={target} className="sandbox-card-host" aria-label="Secure Square test card fields" />
    {checking && <p role="status">Checking your saved sandbox attempt and loading the secure test card…</p>}
    {status?.state === 'completed' && <p role="status">Payment recorded in the Square sandbox. Do not submit again.</p>}
    {status?.state === 'failed' && <p role="status">This sandbox attempt failed. Review the result before starting a new test.</p>}
    {status && !canPay && !['completed','failed'].includes(status.state) && <p role="status">Status: {status.state}. This attempt requires review; no further payment will be submitted automatically.</p>}
    {error && <p role="alert" className="cart-error">{error}</p>}
    {canPay && <button type="button" className="primary-action" disabled={!ready || checking || busy} onClick={pay}>{busy ? 'Checking the same attempt…' : 'Submit sandbox test card'}</button>}
    <button type="button" disabled={checking || busy} onClick={checkStatus}>Check this attempt status</button>
    <p className="sandbox-status-note">The attempt ID remains saved in this browser. A status check never creates a second payment.</p>
  </section>;
}
