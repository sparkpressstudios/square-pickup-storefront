export type MerchantPaymentEnvironment = 'sandbox' | 'production';
/** The only merchant payment configuration safe to send to a browser. */
export interface MerchantPaymentPublicConfig {
  readonly environment: MerchantPaymentEnvironment;
  readonly applicationId: string;
  readonly locationId: string;
  readonly sdkUrl: 'https://sandbox.web.squarecdn.com/v1/square.js' | 'https://web.squarecdn.com/v1/square.js';
}
