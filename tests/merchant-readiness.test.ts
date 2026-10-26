import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMerchantReadiness, validatePickupPolicy, evaluatePickupAvailability } from '../server/src/merchant-readiness';
const pickup = () => ({ timeZone: 'America/New_York', leadMinutes: 15, weeklyHours: [{ weekday: 1, opens: '09:00', closes: '17:00' }], blackoutDates: [] as string[] });
const config = () => ({ reviewed: true, branding: { name: 'Example Goods', tagline: 'Thoughtfully chosen', accentColor: '#a1ab74', backgroundColor: '#f9f8f4' }, support: { email: 'help@example.com', url: 'https://example.com/help' }, policies: { termsUrl: 'https://example.com/terms', privacyUrl: 'https://example.com/privacy', refundUrl: 'https://example.com/refunds' }, inventory: { authority: 'website-allocation', allocationReviewed: true }, pickup: pickup() });
test('reviewed branding/support/policies/website allocation and configured pickup pass a configuration-only gate', () => {
  const input = config(); const report = validateMerchantReadiness(input);
  assert.equal(report.ready, true); assert.deepEqual(report.issues, []);
  assert.equal(report.configuration?.branding.accentColor, '#A1AB74');
  assert.equal(report.configuration?.pickup.timeZone, 'America/New_York');
  assert.equal(input.branding.accentColor, '#a1ab74');
  assert.equal('productionPayments' in report, false);
});
test('missing config, review and POS synchronization fail readiness with actionable codes', () => {
  assert.equal(validateMerchantReadiness(undefined).ready, false);
  const unreviewed = validateMerchantReadiness({ ...config(), reviewed: false, inventory: { authority: 'square-pos', allocationReviewed: false } });
  assert.deepEqual(unreviewed.issues.map(i => i.code), ['REVIEW_REQUIRED', 'POS_SYNC_UNAVAILABLE', 'INVENTORY_ALLOCATION_REVIEW_REQUIRED']);
  assert.equal(unreviewed.ready, false);
  assert.ok(unreviewed.configuration);
  assert.equal(validateMerchantReadiness({ ...config(), pickup: undefined }).configuration, undefined);
});
test('unknown and secret-bearing fields never appear in readiness output', () => {
  for (const input of [{ ...config(), accessToken: 'PRIVATE_CANARY' }, { ...config(), branding: { ...config().branding, accessToken: 'PRIVATE_CANARY' } }, { ...config(), support: { email: 'help@example.com', url: 'https://user:PRIVATE_CANARY@example.com/help' } }, { ...config(), policies: { ...config().policies, termsUrl: 'https://example.com/terms?token=PRIVATE_CANARY' } }]) {
    const result = validateMerchantReadiness(input); assert.equal(result.ready, false); assert.equal(result.configuration, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_CANARY/);
  }
});
test('invalid branding, contact and policy URLs fail without reflecting input', () => {
  for (const branding of [{ ...config().branding, name: '' }, { ...config().branding, tagline: 'bad\nline' }, { ...config().branding, accentColor: 'red' }, { ...config().branding, logoUrl: 'http://example.com/logo.png' }]) assert.equal(validateMerchantReadiness({ ...config(), branding }).ready, false);
  assert.equal(validateMerchantReadiness({ ...config(), support: { ...config().support, email: 'not an email' } }).ready, false);
  for (const url of ['http://example.com/terms', 'https://localhost/terms', 'not-a-url']) assert.equal(validateMerchantReadiness({ ...config(), policies: { ...config().policies, termsUrl: url } }).ready, false);
});
test('pickup validation rejects timezone guesses, malformed intervals, overlap and invalid blackouts', () => {
  for (const policy of [undefined, { ...pickup(), timeZone: 'Mars/Olympus' }, { ...pickup(), timeZone: '+05:00' }, { ...pickup(), leadMinutes: -1 }, { ...pickup(), leadMinutes: 0.5 }, { ...pickup(), leadMinutes: 10081 }, { ...pickup(), weeklyHours: [] }, { ...pickup(), weeklyHours: [{ weekday: 7, opens: '09:00', closes: '17:00' }] }, { ...pickup(), weeklyHours: [{ weekday: 1, opens: '22:00', closes: '02:00' }] }, { ...pickup(), weeklyHours: [{ weekday: 1, opens: '09:00', closes: '17:00' }, { weekday: 1, opens: '16:00', closes: '18:00' }] }, { ...pickup(), blackoutDates: ['2026-02-30'] }, { ...pickup(), blackoutDates: ['2026-10-26', '2026-10-26'] }]) assert.equal(validatePickupPolicy(policy).policy, undefined);
  assert.ok(validatePickupPolicy({ ...pickup(), weeklyHours: [{ weekday: 1, opens: '00:00', closes: '24:00' }] }).policy);
});
test('ASAP uses elapsed lead time, rounds up to a minute and never returns closing time', () => {
  assert.equal(evaluatePickupAvailability(pickup(), { now: '2026-10-26T12:55:30Z' }).promisedAt, '2026-10-26T13:11:00.000Z');
  assert.equal(evaluatePickupAvailability(pickup(), { now: '2026-10-26T20:45:00Z' }).promisedAt, '2026-11-02T14:00:00.000Z');
  assert.equal(evaluatePickupAvailability(pickup(), { now: '2026-10-26T12:00:00Z', selectedAt: '2026-10-26T17:00:00-04:00' }).reason, 'OUTSIDE_PICKUP_HOURS');
});
test('blackouts use local dates and skip to next configured day', () => {
  const policy = { timeZone: 'America/Los_Angeles', leadMinutes: 0, weeklyHours: [{ weekday: 1, opens: '16:00', closes: '24:00' }, { weekday: 2, opens: '09:00', closes: '17:00' }], blackoutDates: ['2026-10-26'] };
  const now = '2026-10-27T01:00:00Z';
  assert.equal(evaluatePickupAvailability(policy, { now, selectedAt: now }).reason, 'BLACKOUT_DATE');
  assert.equal(evaluatePickupAvailability(policy, { now }).promisedAt, '2026-10-27T16:00:00.000Z');
});
test('spring DST skips nonexistent local hours without reducing elapsed preparation time', () => {
  const policy = { ...pickup(), leadMinutes: 10, weeklyHours: [{ weekday: 0, opens: '02:00', closes: '04:00' }] };
  assert.equal(evaluatePickupAvailability(policy, { now: '2026-03-08T06:55:00Z' }).promisedAt, '2026-03-08T07:05:00.000Z');
  const missingHour = { ...policy, leadMinutes: 0, weeklyHours: [{ weekday: 0, opens: '02:00', closes: '03:00' }] };
  assert.equal(evaluatePickupAvailability(missingHour, { now: '2026-03-08T06:50:00Z' }).promisedAt, '2026-03-15T06:00:00.000Z');
});
test('fall DST repeats are distinct explicit instants, and elapsed lead time crosses the repeated hour', () => {
  const policy = { ...pickup(), leadMinutes: 20, weeklyHours: [{ weekday: 0, opens: '01:00', closes: '02:00' }] };
  assert.equal(evaluatePickupAvailability(policy, { now: '2026-11-01T05:50:00Z' }).promisedAt, '2026-11-01T06:10:00.000Z');
  for (const selectedAt of ['2026-11-01T01:30:00-04:00', '2026-11-01T01:30:00-05:00']) assert.equal(evaluatePickupAvailability({ ...policy, leadMinutes: 0 }, { now: '2026-11-01T04:30:00Z', selectedAt }).available, true);
});
test('selected pickup requires explicit instant, elapsed lead time, opening hours and bounded horizon', () => {
  const now = '2026-10-26T13:00:00Z';
  assert.equal(evaluatePickupAvailability(pickup(), { now, selectedAt: '2026-10-26T09:10:00-04:00' }).reason, 'LEAD_TIME_REQUIRED');
  assert.equal(evaluatePickupAvailability(pickup(), { now, selectedAt: '2026-11-23T09:30:00-05:00' }).reason, 'OUTSIDE_BOOKING_WINDOW');
  for (const selectedAt of ['2026-10-26T10:00', '2026-02-30T10:00:00Z', '2026-10-26T10:00:01-04:00']) assert.equal(evaluatePickupAvailability(pickup(), { now, selectedAt }).reason, 'INVALID_TIME');
  assert.equal(evaluatePickupAvailability(pickup(), { now: 'invalid' }).reason, 'INVALID_TIME');
  assert.equal(evaluatePickupAvailability(undefined, { now }).reason, 'INVALID_POLICY');
});
test('fully blacked-out booking horizon returns unavailable and never invents a promise', () => {
  const policy = { ...pickup(), blackoutDates: ['2026-10-26', '2026-11-02', '2026-11-09'] };
  assert.deepEqual(evaluatePickupAvailability(policy, { now: '2026-10-26T12:00:00Z' }), { available: false, reason: 'NO_AVAILABILITY', timeZone: 'America/New_York' });
});
