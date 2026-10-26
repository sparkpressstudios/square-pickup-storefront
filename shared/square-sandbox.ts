export const squareSandboxScript = 'https://sandbox.web.squarecdn.com/v1/square.js';
export interface SandboxPublicConfig { readonly environment: 'sandbox'; readonly applicationId: string; readonly locationId: string }

export function assertSandboxPublicConfig(input: SandboxPublicConfig): void {
  if (input.environment !== 'sandbox' || typeof input.applicationId !== 'string' || typeof input.locationId !== 'string' || !/^sandbox-sq0idb-[A-Za-z0-9_-]+$/.test(input.applicationId) || !/^[A-Za-z0-9]{1,64}$/.test(input.locationId)) throw new Error('A dedicated sandbox application and location are required');
}
