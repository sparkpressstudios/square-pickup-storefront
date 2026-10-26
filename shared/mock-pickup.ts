/** UI-only fictional contact preview. Never part of a quote, checkout request, database or provider payload. */
export interface MockPickupDetails { name: string; email: string; acknowledged: true }
export class MockPickupError extends Error {
  constructor(readonly field: 'name' | 'email' | 'acknowledged' | 'form', message: string) { super(message); }
}
export function parseMockPickup(input: unknown): MockPickupDetails {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new MockPickupError('form', 'Use the fictional pickup form.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'acknowledged,email,name') throw new MockPickupError('form', 'Use only the fictional pickup fields.');
  if (typeof value.name !== 'string' || value.name.trim().length < 2 || value.name.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(value.name)) throw new MockPickupError('name', 'Enter a fictional name with 2–100 characters.');
  if (typeof value.email !== 'string' || !/^[a-z\d][a-z\d._+-]{0,63}@example\.invalid$/i.test(value.email.trim())) throw new MockPickupError('email', 'Use a fictional address ending in @example.invalid. Real email addresses are not accepted.');
  if (value.acknowledged !== true) throw new MockPickupError('acknowledged', 'Confirm that this is a simulation with no real order or pickup reservation.');
  return { name: value.name.trim(), email: value.email.trim().toLowerCase(), acknowledged: true };
}
