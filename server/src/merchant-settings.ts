import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase } from '../../db/sql-database';
import { AdminError } from '../../shared/admin-catalog';
import { merchantDraft, parseMerchantDraft } from '../../shared/merchant-draft';
import { parseMerchantSettingsRequest, type EditableMerchantSettings } from '../../shared/merchant-settings';
import type { MerchantConfig } from '../../shared/storefront';

export interface MerchantSettingsStore {
  load(): Promise<EditableMerchantSettings>;
  update(input: unknown, actorId: string): Promise<EditableMerchantSettings>;
}
type SettingsRow = { presentation: unknown; revision: string; updated_at: Date | string | null };
/** Only non-secret presentation lives here. Commerce, media and providers stay code-owned. */
export class PostgresMerchantSettings implements MerchantSettingsStore {
  private readonly baseline;
  private readonly initialRevision: string;
  constructor(private readonly db: SqlDatabase, base: MerchantConfig) {
    this.baseline = merchantDraft(base);
    this.initialRevision = createHash('sha256').update(JSON.stringify(this.baseline)).digest('hex');
  }
  private view(row: SettingsRow | undefined): EditableMerchantSettings {
    if (!row) throw new Error('Reviewed merchant settings migration is required');
    return { settings: row.presentation === null ? { ...this.baseline } : parseMerchantDraft(row.presentation), revision: row.presentation === null ? this.initialRevision : row.revision, updatedAt: row.updated_at === null ? null : new Date(row.updated_at).toISOString() };
  }
  async load(): Promise<EditableMerchantSettings> {
    return this.view((await this.db.query<SettingsRow>('SELECT presentation, revision, updated_at FROM merchant_presentation WHERE singleton=true')).rows[0]);
  }
  async update(input: unknown, actorId: string): Promise<EditableMerchantSettings> {
    const request = parseMerchantSettingsRequest(input);
    if (!actorId || actorId.length > 200 || /[\u0000-\u001f\u007f]/.test(actorId)) throw new AdminError(403, 'STAFF_FORBIDDEN', 'A verified staff identity is required.');
    return this.db.transaction(async (tx) => {
      const current = this.view((await tx.query<SettingsRow>('SELECT presentation, revision, updated_at FROM merchant_presentation WHERE singleton=true FOR UPDATE')).rows[0]);
      if (current.revision !== request.revision) throw new AdminError(409, 'SETTINGS_CHANGED', 'Settings changed. Reload before saving again.');
      const revision = createHash('sha256').update(randomUUID()).digest('hex');
      const result = await tx.query<SettingsRow>('UPDATE merchant_presentation SET presentation=$1::jsonb, revision=$2, updated_by=$3, updated_at=clock_timestamp() WHERE singleton=true RETURNING presentation, revision, updated_at', [JSON.stringify(request.settings), revision, actorId]);
      return this.view(result.rows[0]);
    });
  }
}
