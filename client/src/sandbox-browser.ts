import { assertSandboxPublicConfig, squareSandboxScript, type SandboxPublicConfig } from '../../shared/square-sandbox';
import type { SandboxSdk } from './square-tokenization';
import type { SandboxCheckoutPort } from '../../shared/sandbox-checkout';

declare global { interface Window { Square?: SandboxSdk } }
let loading: Promise<SandboxSdk> | undefined;
/** Invoked only from the explicitly enabled sandbox panel, never from ordinary demo startup. */
export function loadSandboxSdk(url: typeof squareSandboxScript): Promise<SandboxSdk> {
  if (url !== squareSandboxScript || !window.isSecureContext || window.location.protocol !== 'https:') return Promise.reject(new Error('HTTPS sandbox context is required'));
  if (loading) return loading;
  loading = new Promise<SandboxSdk>((resolve, reject) => {
    const script = document.createElement('script'); script.src = squareSandboxScript; script.async = true; script.referrerPolicy = 'no-referrer';
    const timeout = window.setTimeout(() => { script.remove(); reject(new Error('Sandbox SDK loading timed out')); }, 15000);
    script.onload = () => { window.clearTimeout(timeout); if (window.Square) resolve(window.Square); else reject(new Error('Sandbox SDK unavailable')); };
    script.onerror = () => { window.clearTimeout(timeout); script.remove(); reject(new Error('Sandbox SDK could not be loaded')); };
    document.head.appendChild(script);
  }).catch((error: Error) => { loading = undefined; throw error; });
  return loading;
}
export function sandboxBrowserPort(config: SandboxPublicConfig): SandboxCheckoutPort {
  assertSandboxPublicConfig(config);
  async function post(path: string, body: unknown) {
    const response = await fetch(`/api/sandbox/checkout/${path}`, { method: 'POST', credentials: 'same-origin', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('Sandbox request failed; preserve this checkout identity for status review');
    return response.json();
  }
  return { prepare: (request) => post('prepare', request), submit: (request, cardToken) => post('submit', { request, cardToken }), cancelBeforeDispatch: (request) => post('cancel', request) };
}
