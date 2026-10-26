import type { MerchantPickupPolicy, MerchantReadinessConfiguration, MerchantReadinessReport, PickupAvailability, PickupHours, PickupWeekday, ReadinessIssue } from '../../shared/merchant-readiness';

const minute = 60_000;
/** Bounded pickup-only horizon; callers must not promise a time beyond this window. */
export const pickupBookingHorizonDays = 14;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) ? value as Record<string, unknown> : undefined;
function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && value.trim().length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value); }
function publicUrl(value: unknown): string | undefined {
  if (!text(value, 2048) || value !== value.trim()) return;
  try {
    const url = new URL(value);
    // Query/user-info are excluded: this metadata must not retain signed links or credentials.
    if (url.protocol !== 'https:' || url.username || url.password || url.search || !url.hostname || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return;
    return url.href;
  } catch { return; }
}
function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value)) return false;
  const date = new Date(value + 'T12:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function clockMinutes(value: unknown, closing = false): number | undefined {
  if (closing && value === '24:00') return 1440;
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function zoneFormatter(value: unknown): Intl.DateTimeFormat | undefined {
  if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(value)) return;
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: value, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { return; }
}
/** Structural policy parser. No environment reads, locale-default timezone, provider calls or storage. */
export function validatePickupPolicy(input: unknown): { policy?: MerchantPickupPolicy; issues: ReadinessIssue[] } {
  const issues: ReadinessIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ code: 'PICKUP_CONFIGURATION_REQUIRED', path: 'pickup.' + path, message });
  const raw = object(input);
  if (!raw || !keys(raw, ['timeZone', 'leadMinutes', 'weeklyHours', 'blackoutDates'])) return { issues: [{ code: 'PICKUP_CONFIGURATION_REQUIRED', path: 'pickup', message: 'Configure an explicit timezone, lead time, weekly pickup hours and blackout dates.' }] };
  const formatter = zoneFormatter(raw.timeZone);
  if (!formatter) issue('timeZone', 'Choose a valid IANA timezone, such as America/New_York.');
  if (!Number.isSafeInteger(raw.leadMinutes) || (raw.leadMinutes as number) < 0 || (raw.leadMinutes as number) > 10_080) issue('leadMinutes', 'Choose an elapsed pickup lead time from 0 to 10080 whole minutes.');
  const hours: PickupHours[] = [];
  if (!Array.isArray(raw.weeklyHours) || raw.weeklyHours.length < 1 || raw.weeklyHours.length > 28) issue('weeklyHours', 'Configure 1–28 weekly pickup windows; split overnight hours at midnight.');
  else for (const entry of raw.weeklyHours) {
    const row = object(entry);
    const opens = clockMinutes(row?.opens), closes = clockMinutes(row?.closes, true);
    if (!row || !keys(row, ['weekday', 'opens', 'closes']) || !Number.isSafeInteger(row.weekday) || (row.weekday as number) < 0 || (row.weekday as number) > 6 || opens === undefined || closes === undefined || opens >= closes) {
      issue('weeklyHours', 'Each window needs weekday 0–6 and increasing HH:mm times; 24:00 is allowed only for closing.'); continue;
    }
    hours.push({ weekday: row.weekday as PickupWeekday, opens: row.opens as string, closes: row.closes as string });
  }
  hours.sort((a, b) => a.weekday - b.weekday || a.opens.localeCompare(b.opens));
  for (let i = 1; i < hours.length; i++) {
    const prior = hours[i - 1]!, current = hours[i]!;
    if (prior.weekday === current.weekday && clockMinutes(prior.closes, true)! > clockMinutes(current.opens)!) issue('weeklyHours', 'Pickup windows on the same day must not overlap.');
  }
  const dates = raw.blackoutDates;
  if (!Array.isArray(dates) || dates.length > 366 || dates.some(date => !calendarDate(date)) || new Set(dates).size !== dates.length) issue('blackoutDates', 'Use up to 366 unique valid local YYYY-MM-DD blackout dates.');
  if (issues.length) return { issues };
  return { issues, policy: { timeZone: formatter!.resolvedOptions().timeZone, leadMinutes: raw.leadMinutes as number, weeklyHours: hours, blackoutDates: [...dates as string[]].sort() } };
}
export function validateMerchantReadiness(input: unknown): MerchantReadinessReport {
  const raw = object(input); const issues: ReadinessIssue[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!raw || !keys(raw, ['reviewed', 'branding', 'support', 'policies', 'inventory', 'pickup'])) return { ready: false, issues: [{ code: 'MERCHANT_CONFIGURATION_REQUIRED', path: 'merchant', message: 'Provide only reviewed branding, support, policies, inventory ownership and pickup configuration.' }] };
  const branding = object(raw.branding), support = object(raw.support), policies = object(raw.policies), inventory = object(raw.inventory);
  if (typeof raw.reviewed !== 'boolean') issue('REVIEW_REQUIRED', 'reviewed', 'Record whether the merchant has reviewed this complete configuration.');
  const logo = branding?.logoUrl === undefined ? undefined : publicUrl(branding.logoUrl);
  if (!branding || !keys(branding, ['name', 'tagline', 'accentColor', 'backgroundColor'], ['logoUrl']) || !text(branding.name, 100) || !text(branding.tagline, 200) || typeof branding.accentColor !== 'string' || !/^#[a-f\d]{6}$/i.test(branding.accentColor) || typeof branding.backgroundColor !== 'string' || !/^#[a-f\d]{6}$/i.test(branding.backgroundColor) || (branding.logoUrl !== undefined && !logo)) issue('BRANDING_REQUIRED', 'branding', 'Provide a display name, tagline, two six-digit hex colors and optional public HTTPS logo URL without credentials/query strings.');
  const supportUrl = publicUrl(support?.url);
  if (!support || !keys(support, ['email', 'url']) || !text(support.email, 254) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(support.email) || !supportUrl) issue('SUPPORT_REQUIRED', 'support', 'Provide a support email and public HTTPS support URL without credentials/query strings.');
  const termsUrl = publicUrl(policies?.termsUrl), privacyUrl = publicUrl(policies?.privacyUrl), refundUrl = publicUrl(policies?.refundUrl);
  if (!policies || !keys(policies, ['termsUrl', 'privacyUrl', 'refundUrl']) || !termsUrl || !privacyUrl || !refundUrl) issue('POLICIES_REQUIRED', 'policies', 'Provide public HTTPS terms, privacy and refund-policy links without credentials/query strings.');
  if (!inventory || !keys(inventory, ['authority', 'allocationReviewed']) || !['website-allocation', 'square-pos'].includes(String(inventory.authority)) || typeof inventory.allocationReviewed !== 'boolean') issue('INVENTORY_OWNERSHIP_REQUIRED', 'inventory', 'Select reviewed website stock allocation or Square POS ownership explicitly.');
  const pickup = validatePickupPolicy(raw.pickup); issues.push(...pickup.issues);
  if (issues.length) return { ready: false, issues };
  const configuration: MerchantReadinessConfiguration = {
    reviewed: raw.reviewed as boolean,
    branding: { name: (branding!.name as string).trim(), tagline: (branding!.tagline as string).trim(), accentColor: (branding!.accentColor as string).toUpperCase(), backgroundColor: (branding!.backgroundColor as string).toUpperCase(), ...(logo ? { logoUrl: logo } : {}) },
    support: { email: (support!.email as string).trim(), url: supportUrl! },
    policies: { termsUrl: termsUrl!, privacyUrl: privacyUrl!, refundUrl: refundUrl! },
    inventory: { authority: inventory!.authority as MerchantReadinessConfiguration['inventory']['authority'], allocationReviewed: inventory!.allocationReviewed as boolean },
    pickup: pickup.policy!,
  };
  if (!configuration.reviewed) issue('REVIEW_REQUIRED', 'reviewed', 'Review branding, support, policies, stock ownership and pickup promises before enabling buyer checkout.');
  if (configuration.inventory.authority === 'square-pos') issue('POS_SYNC_UNAVAILABLE', 'inventory.authority', 'Square POS inventory synchronization is unavailable. Allocate separately controlled website stock or keep checkout disabled.');
  if (!configuration.inventory.allocationReviewed) issue('INVENTORY_ALLOCATION_REVIEW_REQUIRED', 'inventory.allocationReviewed', 'Review and reserve a website-only stock allocation; do not reuse unallocated POS inventory.');
  return { ready: issues.length === 0, issues, configuration };
}
function instant(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'number') return Number.isSafeInteger(value) && Math.abs(value) <= 8.64e15 ? value : undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) || !calendarDate(value.slice(0, 10))) return;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}
function localTime(at: number, formatter: Intl.DateTimeFormat) {
  const parts = Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return { date, weekday: new Date(date + 'T12:00:00Z').getUTCDay(), minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}
/** Evaluate UTC instants in an explicit local timezone. Iterating real minutes avoids
 * manufacturing nonexistent DST times and disambiguates repeated fall-back times by offset.
 * Closing is exclusive. No schedule defaults; invalid/unconfigured policies fail closed.
 */
export function evaluatePickupAvailability(input: unknown, options: { now: Date | string | number; selectedAt?: string }): PickupAvailability {
  const checked = validatePickupPolicy(input); if (!checked.policy) return { available: false, reason: 'INVALID_POLICY' };
  const policy = checked.policy, formatter = zoneFormatter(policy.timeZone)!;
  const now = instant(options.now); if (now === undefined) return { available: false, reason: 'INVALID_TIME', timeZone: policy.timeZone };
  const earliest = Math.ceil((now + policy.leadMinutes * minute) / minute) * minute;
  const latest = now + pickupBookingHorizonDays * 24 * 60 * minute;
  if (!Number.isFinite(earliest) || latest > 8.64e15) return { available: false, reason: 'INVALID_TIME', timeZone: policy.timeZone };
  const blackout = new Set(policy.blackoutDates);
  const reasonAt = (at: number): PickupAvailability['reason'] | undefined => {
    const local = localTime(at, formatter);
    if (blackout.has(local.date)) return 'BLACKOUT_DATE';
    if (!policy.weeklyHours.some(hours => hours.weekday === local.weekday && local.minutes >= clockMinutes(hours.opens)! && local.minutes < clockMinutes(hours.closes, true)!)) return 'OUTSIDE_PICKUP_HOURS';
    return;
  };
  if (options.selectedAt !== undefined) {
    const selected = instant(options.selectedAt);
    if (selected === undefined || selected % minute !== 0) return { available: false, reason: 'INVALID_TIME', timeZone: policy.timeZone };
    if (selected < earliest) return { available: false, reason: 'LEAD_TIME_REQUIRED', timeZone: policy.timeZone };
    if (selected > latest) return { available: false, reason: 'OUTSIDE_BOOKING_WINDOW', timeZone: policy.timeZone };
    const reason = reasonAt(selected); return reason ? { available: false, reason, timeZone: policy.timeZone } : { available: true, promisedAt: new Date(selected).toISOString(), timeZone: policy.timeZone };
  }
  for (let at = earliest; at <= latest; at += minute) if (!reasonAt(at)) return { available: true, promisedAt: new Date(at).toISOString(), timeZone: policy.timeZone };
  return { available: false, reason: 'NO_AVAILABILITY', timeZone: policy.timeZone };
}
