/**
 * A deliberately fictional PICKUP fulfillment used ONLY by the Square sandbox adapter.
 * Not a customer's contact, a real pickup window, or permission to fulfill merchandise.
 * The production commerce path remains disabled and must replace this entire contract.
 */
export const SANDBOX_PICKUP_CONTACT = Object.freeze({
  display_name: 'Sandbox Test Shopper',
  email_address: 'shopper@example.invalid',
  phone_number: '+12025550100', // US 555-0100 is reserved for fiction
});

export function sandboxPickupFulfillments() {
  return [{
    type: 'PICKUP' as const,
    state: 'PROPOSED' as const,
    pickup_details: {
      recipient: { ...SANDBOX_PICKUP_CONTACT },
      schedule_type: 'ASAP' as const,
      prep_time_duration: 'PT15M',
      note: 'SANDBOX TEST ONLY - no real pickup or fulfillment is authorized.',
    },
  }];
}

/** Reject paid order evidence that is not the specific pickup test we submitted. */
export function matchesSandboxPickupOrder(order: unknown): boolean {
  if (!order || typeof order !== 'object' || Array.isArray(order)) return false;
  const fulfillments = (order as { fulfillments?: unknown }).fulfillments;
  if (!Array.isArray(fulfillments) || fulfillments.length !== 1) return false;
  const [fulfillment] = fulfillments;
  if (!fulfillment || typeof fulfillment !== 'object' || Array.isArray(fulfillment)) return false;
  const value = fulfillment as Record<string, unknown>;
  if (value.type !== 'PICKUP') return false;
  const details = value.pickup_details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const recipient = (details as { recipient?: unknown }).recipient;
  if (!recipient || typeof recipient !== 'object' || Array.isArray(recipient)) return false;
  const contact = recipient as Record<string, unknown>;
  return contact.display_name === SANDBOX_PICKUP_CONTACT.display_name &&
    contact.email_address === SANDBOX_PICKUP_CONTACT.email_address &&
    contact.phone_number === SANDBOX_PICKUP_CONTACT.phone_number;
}
