import { sql } from 'drizzle-orm';
import { boolean, check, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import type { MerchantDraft } from '../../shared/merchant-draft';

export const merchantPresentation = pgTable('merchant_presentation', {
  singleton: boolean('singleton').primaryKey().default(true),
  presentation: jsonb('presentation').$type<MerchantDraft>(),
  revision: text('revision').notNull(),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
}, (table) => [
  check('merchant_presentation_singleton', sql`${table.singleton} = true`),
  check('merchant_presentation_revision', sql`${table.revision} ~ '^[a-f0-9]{64}$'`),
  check('merchant_presentation_object', sql`${table.presentation} IS NULL OR jsonb_typeof(${table.presentation}) = 'object'`),
  check('merchant_presentation_metadata', sql`(${table.presentation} IS NULL AND ${table.updatedBy} IS NULL AND ${table.updatedAt} IS NULL) OR (${table.presentation} IS NOT NULL AND ${table.updatedBy} IS NOT NULL AND ${table.updatedAt} IS NOT NULL)`),
]);
