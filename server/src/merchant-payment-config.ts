import { sandboxConfiguration, type SandboxServerConfig } from './square-sandbox';
import type { MerchantPaymentEnvironment, MerchantPaymentPublicConfig } from '../../shared/merchant-payment-config';
export interface MerchantPaymentServerConfig {
  readonly environment: MerchantPaymentEnvironment;
  readonly applicationId: string; readonly locationId: string; readonly merchantId: string;
  readonly accessToken: string; readonly webhookSignatureKey: string;
  readonly apiOrigin: 'https://connect.squareupsandbox.com' | 'https://connect.squareup.com';
  readonly sdkUrl: MerchantPaymentPublicConfig['sdkUrl'];
}
export interface MerchantWebhookConfig {
  readonly environment: MerchantPaymentEnvironment; readonly signatureKey: string;
  readonly notificationUrl: string; readonly merchantId: string; readonly locationId: string;
}
export class MerchantPaymentConfigurationError extends Error {
  constructor(readonly code: 'PROVIDERS_DISABLED' | 'INVALID_CONFIGURATION' | 'UNVALIDATED_CONFIGURATION') { super(code); }
}
const validated = new WeakSet<object>(); const webhooks = new WeakSet<object>();
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(value);
const secret = (value: unknown): value is string => typeof value === 'string' && /^\S{16,4096}$/.test(value);
const reject = (code: MerchantPaymentConfigurationError['code']): never => { throw new MerchantPaymentConfigurationError(code); };
/** Explicit supplied values only: no env files, credentials discovery, network, or activation side effects.
 * Production cannot borrow generic/sandbox identifiers or secrets. Setting a production environment
 * alone never opens the gate. Provisioning/activation remains the deployment owner's explicit action.
 */
export function merchantPaymentConfiguration(values: Readonly<Record<string, string | undefined>>): MerchantPaymentServerConfig {
  let config: MerchantPaymentServerConfig;
  if (values.SQUARE_ENVIRONMENT === 'sandbox') {
    if (values.SQUARE_SANDBOX_REQUESTS_ENABLED !== 'true') return reject('PROVIDERS_DISABLED');
    let sandbox: SandboxServerConfig; try { sandbox = sandboxConfiguration(values); } catch { return reject('INVALID_CONFIGURATION'); }
    if (!identifier(values.SQUARE_SANDBOX_MERCHANT_ID) || !secret(values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY)) return reject('INVALID_CONFIGURATION');
    config = { ...sandbox, merchantId: values.SQUARE_SANDBOX_MERCHANT_ID, webhookSignatureKey: values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY, apiOrigin: 'https://connect.squareupsandbox.com', sdkUrl: 'https://sandbox.web.squarecdn.com/v1/square.js' };
  } else if (values.SQUARE_ENVIRONMENT === 'production') {
    if (values.SQUARE_PRODUCTION_PAYMENTS_ENABLED !== 'true') return reject('PROVIDERS_DISABLED');
    const applicationId = values.SQUARE_PRODUCTION_APPLICATION_ID, locationId = values.SQUARE_PRODUCTION_LOCATION_ID, merchantId = values.SQUARE_PRODUCTION_MERCHANT_ID, accessToken = values.SQUARE_PRODUCTION_ACCESS_TOKEN, webhookSignatureKey = values.SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY;
    if (typeof applicationId !== 'string' || !/^sq0id[bp]-[A-Za-z0-9_-]{1,128}$/.test(applicationId) || !identifier(locationId) || !identifier(merchantId) || !secret(accessToken) || !secret(webhookSignatureKey) || accessToken.startsWith('sandbox-') ||
        accessToken === values.SQUARE_SANDBOX_ACCESS_TOKEN || webhookSignatureKey === values.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY)
      return reject('INVALID_CONFIGURATION');
    config = { environment: 'production', applicationId, locationId, merchantId, accessToken, webhookSignatureKey, apiOrigin: 'https://connect.squareup.com', sdkUrl: 'https://web.squarecdn.com/v1/square.js' };
  } else return reject('PROVIDERS_DISABLED');
  Object.freeze(config); validated.add(config); return config;
}
/** Existing synthetic sandbox constructor stays compatible. A forged production structural object
 * cannot bypass the production enable gate; production configs must originate from the loader above.
 */
export function merchantProviderConfiguration(input: SandboxServerConfig | MerchantPaymentServerConfig): SandboxServerConfig | MerchantPaymentServerConfig {
  if (input?.environment === 'production') { if (!validated.has(input)) return reject('UNVALIDATED_CONFIGURATION'); return input; }
  try { return sandboxConfiguration({ SQUARE_ENVIRONMENT: input?.environment, SQUARE_APPLICATION_ID: input?.applicationId, SQUARE_LOCATION_ID: input?.locationId, SQUARE_SANDBOX_ACCESS_TOKEN: input?.accessToken }); }
  catch { return reject('INVALID_CONFIGURATION'); }
}
export function assertMerchantPaymentConfiguration(config: MerchantPaymentServerConfig): void { if (!validated.has(config)) reject('UNVALIDATED_CONFIGURATION'); }
export function publicMerchantPaymentConfiguration(config: MerchantPaymentServerConfig): MerchantPaymentPublicConfig {
  if (!validated.has(config)) return reject('UNVALIDATED_CONFIGURATION');
  return Object.freeze({ environment: config.environment, applicationId: config.applicationId, locationId: config.locationId, sdkUrl: config.sdkUrl });
}
export function merchantWebhookConfiguration(config: MerchantPaymentServerConfig, notificationUrl: string): MerchantWebhookConfig {
  if (!validated.has(config)) return reject('UNVALIDATED_CONFIGURATION');
  let url: URL; try { url = new URL(notificationUrl); } catch { return reject('INVALID_CONFIGURATION'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return reject('INVALID_CONFIGURATION');
  const webhook = Object.freeze({ environment: config.environment, signatureKey: config.webhookSignatureKey, notificationUrl, merchantId: config.merchantId, locationId: config.locationId });
  webhooks.add(webhook); return webhook;
}
export function assertMerchantWebhookConfiguration(config: MerchantWebhookConfig): void {
  if (!webhooks.has(config)) reject('UNVALIDATED_CONFIGURATION');
}
