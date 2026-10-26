export type ShoppingStep = 'shop' | 'product' | 'cart' | 'pickup' | 'checkout' | 'confirmation';
export interface ShoppingState { items: number; attempt: boolean; receipt: boolean; pickup: boolean; quoted: boolean }
/** A saved attempt must remain resumable even when an in-memory quote/pickup was lost. */
export function checkoutPrerequisite(state: ShoppingState): string | undefined {
  if (state.attempt || state.receipt) return undefined;
  if (!state.items) return 'Add an item to your cart before checkout.';
  if (!state.pickup) return 'Complete pickup details and review your cart to unlock checkout.';
  if (!state.quoted) return 'Review your cart from the Pickup step to unlock checkout.';
  return undefined;
}
export function shoppingStep(hash: string): ShoppingStep {
  const value = hash.replace(/^#/, '');
  if (/^product\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return 'product';
  return ['cart', 'pickup', 'checkout', 'confirmation'].includes(value) ? value as ShoppingStep : 'shop';
}
/** Navigation cannot skip server review or discard an unknown checkout outcome. */
export function availableStep(step: ShoppingStep, state: ShoppingState): ShoppingStep {
  if (step === 'shop' || step === 'product') return step;
  if (state.receipt) return 'confirmation';
  if (state.attempt) return 'checkout';
  if (!state.items) return 'cart';
  if (step === 'confirmation') return 'cart';
  if (step === 'checkout' && (!state.pickup || !state.quoted)) return 'pickup';
  return step;
}

