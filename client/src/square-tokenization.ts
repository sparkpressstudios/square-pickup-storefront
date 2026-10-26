import { assertSandboxPublicConfig, squareSandboxScript, type SandboxPublicConfig } from '../../shared/square-sandbox';

export interface SandboxBillingContact {
  givenName?: string; familyName?: string; email?: string; phone?: string;
  addressLines?: string[]; city?: string; state?: string; countryCode: 'US';
}
export interface VerificationDetails {
  amount: string; currencyCode: 'USD'; intent: 'CHARGE'; customerInitiated: true; sellerKeyedIn: false;
  billingContact: SandboxBillingContact;
}
export interface SandboxCard {
  attach(target: string): Promise<void>; destroy(): Promise<unknown>;
  tokenize(details: VerificationDetails): Promise<{ status: string; token?: string }>;
}
export interface SandboxSdk { payments(applicationId: string, locationId: string): { card(): Promise<SandboxCard> } }
export interface TokenizationDependencies {
  /** The caller must explicitly load this fixed sandbox URL. No default DOM/network loader. */
  loadSdk(url: typeof squareSandboxScript): Promise<SandboxSdk>;
  isSecureContext: boolean;
}

/** Prepared lifecycle only; application startup/UI do not call this module. */
export async function attachSandboxCard(config: SandboxPublicConfig, target: string, dependencies: TokenizationDependencies) {
  assertSandboxPublicConfig(config);
  if (!dependencies.isSecureContext || !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(target)) throw new Error('A secure sandbox context and card container are required');
  const sdk = await dependencies.loadSdk(squareSandboxScript);
  const card = await sdk.payments(config.applicationId, config.locationId).card();
  try { await card.attach(target); } catch { try { await card.destroy(); } catch { /* Sanitized lifecycle failure below. */ } throw new Error('Sandbox card could not be attached'); }
  let destroyed = false; let inFlight: Promise<string> | undefined; let inFlightIdentity: string | undefined;
  return {
    async tokenize(totalMinor: number, billingContact: SandboxBillingContact): Promise<string> {
      if (destroyed || !Number.isSafeInteger(totalMinor) || totalMinor < 1 || totalMinor > 2_147_483_647 || billingContact.countryCode !== 'US') throw new Error('Valid server-quoted USD amount and sandbox billing contact are required');
      const allowed = ['givenName', 'familyName', 'email', 'phone', 'addressLines', 'city', 'state', 'countryCode'];
      if (Object.keys(billingContact).some((key) => !allowed.includes(key))) throw new Error('Only sandbox billing-contact fields are accepted');
      const identity = JSON.stringify([totalMinor, billingContact]);
      if (inFlight) { if (identity !== inFlightIdentity) throw new Error('Another tokenization request is in progress'); return inFlight; }
      inFlightIdentity = identity;
      inFlight = (async () => {
        try {
          const result = await card.tokenize({ amount: (totalMinor / 100).toFixed(2), currencyCode: 'USD', intent: 'CHARGE', customerInitiated: true, sellerKeyedIn: false, billingContact: structuredClone(billingContact) });
          if (destroyed || result.status !== 'OK' || !result.token || !/^\S{1,512}$/.test(result.token)) throw new Error();
          return result.token;
        } catch { throw new Error('Sandbox tokenization did not complete. No payment request was sent'); }
      })();
      try { return await inFlight; } finally { inFlight = undefined; inFlightIdentity = undefined; }
    },
    async destroy() { if (!destroyed) { destroyed = true; await card.destroy(); } },
  };
}
