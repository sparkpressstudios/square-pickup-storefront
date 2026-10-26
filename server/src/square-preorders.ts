import { SANDBOX_PICKUP_CONTACT } from './sandbox-pickup';

/**
 * Square Orders API scheduled pickup contract, preview only.
 * Never calls CreateOrder, holds inventory, sends email or authorizes pickup.
 */
export class SquarePreorderError extends Error {
  constructor(readonly code: 'INVALID_WINDOW' | 'INVALID_PICKUP_TIME' | 'PREORDER_DISABLED') { super(code); }
}
export interface PreorderPreview {
  readonly mode: 'square-sandbox-preview';
  readonly pickupAt: string;
  readonly windowMinutes: 15 | 30 | 60;
  readonly scheduleType: 'SCHEDULED';
  readonly orderCreated: false;
  readonly inventoryReserved: false;
  readonly customerNotified: false;
  readonly checkoutAuthorized: false;
  readonly requiresSlotCapacity: true;
}
export interface PreorderPolicy {
  readonly enabled: boolean;
  readonly minLeadMinutes: number;
  readonly maxDaysAhead: number;
}
function isStrictDate(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 35 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}
function exactKeys(value: unknown): value is { pickupAt: string; windowMinutes: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) return false;
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  return keys.length === 2 && keys.includes('pickupAt') && keys.includes('windowMinutes') &&
    isStrictDate(object.pickupAt) && [15,30,60].includes(object.windowMinutes as number);
}
export function validatePreorderWindow(input: unknown, policy: PreorderPolicy, clock = Date.now()): PreorderPreview {
  if (!policy.enabled) throw new SquarePreorderError('PREORDER_DISABLED');
  if (!Number.isSafeInteger(clock) || !Number.isFinite(clock) ||
      !Number.isSafeInteger(policy.minLeadMinutes) || policy.minLeadMinutes < 30 || policy.minLeadMinutes > 10080 ||
      !Number.isSafeInteger(policy.maxDaysAhead) || policy.maxDaysAhead < 1 || policy.maxDaysAhead > 90 ||
      !exactKeys(input)) throw new SquarePreorderError('INVALID_WINDOW');
  const when = Date.parse(input.pickupAt);
  if (!Number.isFinite(when) || when < clock + policy.minLeadMinutes * 60000 ||
      when > clock + policy.maxDaysAhead * 86400000) throw new SquarePreorderError('INVALID_PICKUP_TIME');
  // A merchant must later enable real slots/capacity in their configured timezone.
  if (new Date(when).getUTCSeconds() !== 0 || new Date(when).getUTCMilliseconds() !== 0 ||
      new Date(when).getUTCMinutes() % 15 !== 0) throw new SquarePreorderError('INVALID_PICKUP_TIME');
  return {
    mode: 'square-sandbox-preview', pickupAt: new Date(when).toISOString(),
    windowMinutes: input.windowMinutes as 15 | 30 | 60, scheduleType: 'SCHEDULED',
    orderCreated: false, inventoryReserved: false, customerNotified: false,
    checkoutAuthorized: false, requiresSlotCapacity: true,
  };
}
/** This is an isolated Square Orders API fragment, NOT a provider dispatch. */
export function scheduledSquarePickupFulfillment(preview: PreorderPreview) {
  if (preview.mode !== 'square-sandbox-preview' || preview.scheduleType !== 'SCHEDULED' ||
      preview.orderCreated !== false || preview.checkoutAuthorized !== false ||
      ![15,30,60].includes(preview.windowMinutes) || !isStrictDate(preview.pickupAt))
    throw new SquarePreorderError('INVALID_WINDOW');
  return {
    type: 'PICKUP' as const,
    state: 'PROPOSED' as const,
    pickup_details: {
      recipient: { ...SANDBOX_PICKUP_CONTACT },
      schedule_type: 'SCHEDULED' as const,
      pickup_at: preview.pickupAt,
      pickup_window_duration: 'PT' + preview.windowMinutes + 'M',
      note: 'SQUARE SANDBOX PREVIEW ONLY: no order, charge, pickup or customer notification.',
    },
  };
}
