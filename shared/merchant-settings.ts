import { AdminError } from './admin-catalog';
import { MerchantDraftError, parseMerchantDraft, type MerchantDraft } from './merchant-draft';

export interface EditableMerchantSettings { settings: MerchantDraft; revision: string; updatedAt: string | null }
export interface MerchantSettingsRequest { settings: MerchantDraft; revision: string }
export function parseMerchantSettingsRequest(input: unknown): MerchantSettingsRequest {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new AdminError(400, 'INVALID_SETTINGS', 'Use the listed presentation fields and current revision.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'settings') || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) throw new AdminError(400, 'INVALID_SETTINGS', 'Use the listed presentation fields and current revision.');
  try { return { settings: parseMerchantDraft(value.settings), revision: value.revision }; }
  catch (error) {
    if (error instanceof MerchantDraftError) throw new AdminError(400, 'INVALID_SETTINGS', `${error.field}: ${error.message}`);
    throw error;
  }
}
