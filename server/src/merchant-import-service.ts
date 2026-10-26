import type { SqlDatabase } from '../../db/sql-database';
import { previewSquareSandboxCatalog, previewSquareMerchantCatalog, previewConfiguration, type SquareCatalogPreviewConfig, type SquareCatalogImportOptions } from './square-catalog-readonly';
import { MerchantCatalogImportStore, type InventoryOwner, type MerchantImportReview,
  type MerchantImportStatus, type MerchantStageResult, type MerchantCatalogIdentity } from './merchant-catalog-import';
import { squareApiVersion } from './square-sandbox';
import {merchantPaymentConfiguration,assertMerchantPaymentConfiguration,type MerchantPaymentServerConfig} from './merchant-payment-config';

/**
 * Opt-in service for an already provisioned fresh merchant database and a verified
 * staff-session adapter. Constructing it does NOT open connections or call Square.
 * Never enable it in the existing synthetic starter runtime.
 */
export interface MerchantImportAdministration {
  status(): Promise<MerchantImportStatus>;
  stage(owner: InventoryOwner): Promise<MerchantImportReview>;
  inspect(fingerprint: string): Promise<MerchantImportReview>;
  commit(fingerprint: string, actorId: string, approval: 'approve-disabled-merchant-import-v1'): Promise<MerchantStageResult>;
}
export class MerchantImportSetupError extends Error {
  constructor(readonly code: 'IMPORT_CONFIGURATION' | 'SELLER_UNVERIFIED') { super(code); }
}
const merchantIdValid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,192}$/.test(value);
const host = 'https://connect.squareupsandbox.com';
async function readVerification(url: string, config: {token:string;locationId:string}, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { Authorization: 'Bearer ' + config.token, 'Square-Version': squareApiVersion, Accept: 'application/json' } });
  } catch { throw new MerchantImportSetupError('SELLER_UNVERIFIED'); }
  if (response.status !== 200 || Number(response.headers.get('content-length') ?? 0) > 64 * 1024)
    throw new MerchantImportSetupError('SELLER_UNVERIFIED');
  const reader = response.body?.getReader(); if (!reader) throw new MerchantImportSetupError('SELLER_UNVERIFIED');
  let size = 0; const buffers: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > 64 * 1024) throw new MerchantImportSetupError('SELLER_UNVERIFIED');
      buffers.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  let object: unknown;
  try { object = JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { throw new MerchantImportSetupError('SELLER_UNVERIFIED'); }
  if (!object || typeof object !== 'object' || Array.isArray(object) ||
      ('errors' in object && (object as { errors?: unknown }).errors != null))
    throw new MerchantImportSetupError('SELLER_UNVERIFIED');
  return object as Record<string, unknown>;
}
/** A token is never assumed to belong to the configured seller/location. */
export async function verifySquareImportSeller(config: {token:string;locationId:string}, identity: MerchantCatalogIdentity,
  fetcher: typeof fetch, verifiedProduction?:MerchantPaymentServerConfig): Promise<void> {
  if(verifiedProduction)assertMerchantPaymentConfiguration(verifiedProduction);
  const api=verifiedProduction?.apiOrigin??host;
  const merchants = await readVerification(api + '/v2/merchants', config, fetcher);
  const sellerRows = merchants.merchant ?? merchants.merchants;
  if (!Array.isArray(sellerRows) ||
      !sellerRows.some(row => !!row && typeof row === 'object' && !Array.isArray(row) && row.id === identity.squareMerchantId))
    throw new MerchantImportSetupError('SELLER_UNVERIFIED');
  const locations = await readVerification(api + '/v2/locations', config, fetcher);
  if (!Array.isArray(locations.locations) ||
      !locations.locations.some(row => !!row && typeof row === 'object' && !Array.isArray(row) &&
        row.id === identity.squareLocationId && (row.merchant_id == null || row.merchant_id === identity.squareMerchantId) &&
        (!verifiedProduction || (row.currency === 'USD' && row.status === 'ACTIVE' && Array.isArray(row.capabilities) && row.capabilities.includes('CARD_PROCESSING')))))
    throw new MerchantImportSetupError('SELLER_UNVERIFIED');
}
export function createSquareMerchantImportAdministration(db: SqlDatabase,
  values: Readonly<Record<string, string | undefined>>,
  fetcher: typeof fetch): MerchantImportAdministration {
  if(!db||typeof db.transaction!=='function'||typeof fetcher!=='function'||values.STARTER_DATASET!=='merchant-catalog-v1')throw new MerchantImportSetupError('IMPORT_CONFIGURATION');
  let production:MerchantPaymentServerConfig|undefined,config:{token:string;locationId:string},merchantId:string;
  try{
   if(values.SQUARE_ENVIRONMENT==='production'){
    production=merchantPaymentConfiguration(values);config={token:production.accessToken,locationId:production.locationId};merchantId=production.merchantId;
   }else{
    if(values.SQUARE_ENVIRONMENT!=='sandbox'||values.SQUARE_SANDBOX_REQUESTS_ENABLED!=='true'||!merchantIdValid(values.SQUARE_SANDBOX_MERCHANT_ID))throw new Error();
    config=previewConfiguration(values);merchantId=values.SQUARE_SANDBOX_MERCHANT_ID!;
   }
  }catch{throw new MerchantImportSetupError('IMPORT_CONFIGURATION');}
  const identity:MerchantCatalogIdentity={squareMerchantId:merchantId,squareLocationId:config.locationId};
  const options:SquareCatalogImportOptions=values.SQUARE_MERCHANT_COMMERCE_ENABLED==='true'?{taxTreatment:'square-order-authoritative',...(production?{environment:'production' as const}:{})}:{};
  const store = new MerchantCatalogImportStore(db, options);
  return {
    status: () => store.status(identity),
    inspect: (fingerprint) => store.inspect(fingerprint, identity),
    async stage(owner) {
      if (owner !== 'square' && owner !== 'website') throw new MerchantImportSetupError('IMPORT_CONFIGURATION');
      // Refuse synthetic/wrong seller before attempting even a read-only Square request.
      await store.status(identity);
      await verifySquareImportSeller(config, identity, fetcher,production);
      const preview = production?await previewSquareMerchantCatalog(production,fetcher,options):await previewSquareSandboxCatalog(config as SquareCatalogPreviewConfig, fetcher, options);
      const receipt = await store.stage(preview, identity, owner);
      return store.inspect(receipt.fingerprint, identity);
    },
    commit: (fingerprint, actorId, approval) => store.commit(fingerprint, identity, actorId, approval),
  };
}

