import express from 'express';
import type { SqlDatabase } from '../../db/sql-database';
import type { SandboxPublicConfig } from '../../shared/square-sandbox';
import { PreparedSandboxStore } from './prepared-sandbox-store';
import { PreparedSandboxCheckout } from './prepared-sandbox-checkout';
import { sandboxConfiguration, publicSandboxConfiguration, type SandboxTransport } from './square-sandbox';
import { SandboxWebhookProjector, sandboxWebhookRouter } from './square-webhooks';
import { sandboxAttemptBridge } from './sandbox-event-bridge';
import { publicOrigin, validWriteOrigin } from './origin';
import { SandboxCheckoutError } from '../../shared/sandbox-checkout';

/** The only real transport is a fixed sandbox allowlist, with redirects rejected and a bounded response. */
export function sandboxHttpTransport(fetcher: typeof fetch = globalThis.fetch): SandboxTransport {
  return async (request) => {
    if (!['https://connect.squareupsandbox.com/v2/orders','https://connect.squareupsandbox.com/v2/payments'].includes(request.url) || request.method !== 'POST' || request.redirect !== 'error') throw new Error('Sandbox transport target refused');
    const response = await fetcher(request.url, { method: 'POST', headers: request.headers, body: request.body, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (Number(response.headers.get('content-length') ?? 0) > 256 * 1024) throw new Error('Sandbox response too large');
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing sandbox response');
    let bytes = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 256 * 1024) throw new Error('Sandbox response too large'); chunks.push(value); } }
    finally { await reader.cancel().catch(() => {}); }
    const raw = Buffer.concat(chunks); return { status: response.status, body: JSON.parse(raw.toString('utf8')) };
  };
}
export interface RuntimeSandbox { publicConfig: SandboxPublicConfig; router: express.Router }
export function createRuntimeSandbox(db: SqlDatabase, values: Readonly<Record<string, string | undefined>>, origin: string, transport?: SandboxTransport): RuntimeSandbox {
  if (values.SQUARE_SANDBOX_REQUESTS_ENABLED !== 'true' || values.STARTER_DATASET !== 'synthetic-retail-v1') throw new SandboxCheckoutError('PROVIDERS_DISABLED', 'Explicit sandbox activation and synthetic dataset are required.');
  const canonical = publicOrigin(origin, true); const configuration = sandboxConfiguration(values);
  const merchantId = values.SQUARE_SANDBOX_MERCHANT_ID;
  if (!merchantId || !/^[A-Za-z0-9_-]{1,192}$/.test(merchantId) || !values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY) throw new Error('Sandbox merchant and signing configuration are required');
  const notificationUrl = `${canonical}/api/sandbox/webhooks`;
  const projector = new SandboxWebhookProjector(db, { environment: 'sandbox', merchantId, locationId: configuration.locationId, notificationUrl, signatureKey: values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY }, sandboxAttemptBridge(configuration.applicationId, merchantId, configuration.locationId));
  const checkout = new PreparedSandboxCheckout(new PreparedSandboxStore(db, { merchantId }), { execution: 'sandbox-only', configuration, transport: transport ?? sandboxHttpTransport() });
  const router = express.Router(); router.use('/webhooks', sandboxWebhookRouter(projector));
  const writes = express.Router();
  writes.use((req, res, next) => {
    if (!validWriteOrigin(req, canonical, true)) { res.status(403).json({ error: { code: 'INVALID_ORIGIN', message: 'Use the configured sandbox application origin.' } }); return; }
    if (!req.is('application/json')) { res.status(415).json({ error: { code: 'INVALID_REQUEST', message: 'Send application/json.' } }); return; } next();
  }, express.json({ limit: '24kb', strict: true }));
  writes.post('/prepare', async (req, res) => res.json(await checkout.prepare(req.body)));
  writes.post('/cancel', async (req, res) => res.json(await checkout.cancelBeforeDispatch(req.body)));
  writes.post('/submit', async (req, res) => {
    if (!req.body || Object.keys(req.body).sort().join(',') !== 'cardToken,request') { res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Use only the prepared request and tokenized card.' } }); return; }
    const result = await checkout.submit(req.body.request, req.body.cardToken);
    if (result.paymentId) await projector.reconcilePending(result.paymentId);
    res.json(await checkout.prepare(req.body.request));
  });
  router.use('/checkout', writes);
  return { publicConfig: publicSandboxConfiguration(configuration), router };
}
