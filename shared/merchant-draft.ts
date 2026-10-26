import type { MerchantConfig } from './storefront';

/** Presentation-only draft. Never accepts credentials, provider settings, media URLs or catalog data. */
export interface MerchantDraft {
  name: string; descriptor: string; tagline: string; introduction: string;
  pickupLabel: string; pickupInstructions: string; accent: string; background: string;
}
export const paperColors = [
  { value: '#F9F8F4', label: 'Warm cream' },
  { value: '#FFFFFF', label: 'Clean white' },
  { value: '#F0F4ED', label: 'Soft sage' },
  { value: '#F8F2ED', label: 'Light sandstone' },
] as const;
export class MerchantDraftError extends Error {
  constructor(readonly field: keyof MerchantDraft | 'form', message: string) { super(message); }
}
const textLimits = { name: 80, descriptor: 100, tagline: 100, introduction: 400, pickupLabel: 100, pickupInstructions: 600 } as const;
const fields = [...Object.keys(textLimits), 'accent', 'background'];
export function parseMerchantDraft(input: unknown): MerchantDraft {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new MerchantDraftError('form', 'Use only the listed demo presentation settings.');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) throw new MerchantDraftError('form', 'Use only the listed demo presentation settings.');
  const result = {} as MerchantDraft;
  for (const [field, maximum] of Object.entries(textLimits) as [keyof typeof textLimits, number][]) {
    const raw = value[field];
    const normalized = typeof raw === 'string' ? raw.trim().replace(/\r\n/g, '\n') : '';
    const multiline = field === 'introduction' || field === 'pickupInstructions';
    if (!normalized || normalized.length > maximum || /[\u0000-\u0009\u000b-\u001f\u007f]/.test(normalized) || (!multiline && normalized.includes('\n'))) throw new MerchantDraftError(field, `Enter 1–${maximum} characters without control characters.`);
    result[field] = normalized;
  }
  if (typeof value.accent !== 'string' || !/^#[a-f\d]{6}$/i.test(value.accent)) throw new MerchantDraftError('accent', 'Use a six-digit hex color, such as #A1AB74.');
  result.accent = value.accent.toUpperCase();
  if (typeof value.background !== 'string' || !paperColors.some((color) => color.value === value.background!.toString().toUpperCase())) throw new MerchantDraftError('background', 'Choose one of the light storefront backgrounds.');
  result.background = value.background.toUpperCase();
  return result;
}
export function merchantDraft(merchant: MerchantConfig): MerchantDraft {
  return parseMerchantDraft({ name: merchant.name, descriptor: merchant.descriptor, tagline: merchant.tagline, introduction: merchant.introduction, pickupLabel: merchant.pickup.label, pickupInstructions: merchant.pickup.instructions, accent: merchant.theme.accent, background: merchant.theme.background });
}
export function applyMerchantDraft(base: MerchantConfig, input: unknown): MerchantConfig {
  const value = parseMerchantDraft(input);
  return { ...base, name: value.name, descriptor: value.descriptor, tagline: value.tagline, introduction: value.introduction, pickup: { label: value.pickupLabel, instructions: value.pickupInstructions }, theme: { accent: value.accent, background: value.background } };
}
/** Black/white selection gives readable text for every allowed accent color. */
export function accentInk(color: string): '#000000' | '#FFFFFF' {
  if (!/^#[a-f\d]{6}$/i.test(color)) throw new MerchantDraftError('accent', 'Use a six-digit hex color.');
  const linear = [1, 3, 5].map((index) => {
    const value = Number.parseInt(color.slice(index, index + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * linear[0]! + .7152 * linear[1]! + .0722 * linear[2]!;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#FFFFFF';
}
