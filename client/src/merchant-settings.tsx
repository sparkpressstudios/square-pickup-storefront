import { useId, useRef, useState } from 'react';
import type { MerchantConfig } from '../../shared/storefront';
import { applyMerchantDraft, merchantDraft, MerchantDraftError, paperColors, parseMerchantDraft, type MerchantDraft } from '../../shared/merchant-draft';
import { merchantTheme, ShopHero, StoreBrand } from './storefront-brand';

const labels = { name: 'Store name', descriptor: 'Short descriptor', tagline: 'Storefront headline', introduction: 'Storefront introduction', pickupLabel: 'Pickup label', pickupInstructions: 'Pickup instructions', accent: 'Accent color', background: 'Storefront background' } as const;
const maximums = { name: 80, descriptor: 100, tagline: 100, introduction: 400, pickupLabel: 100, pickupInstructions: 600 } as const;

interface SettingsFormProps { merchant: MerchantConfig; baseline: MerchantConfig; onApply: (merchant: MerchantConfig) => void; onOpenSetup?: () => void }
export function MerchantSettingsPreview(props: SettingsFormProps) { return <PresentationSettingsForm {...props} />; }
export function MerchantSettingsEditor(props: SettingsFormProps & { onSave: (settings: MerchantDraft) => Promise<void>; onReload: () => void }) { return <PresentationSettingsForm {...props} />; }
function PresentationSettingsForm({ merchant, baseline, onApply, onOpenSetup, onSave, onReload }: SettingsFormProps & { onSave?: (settings: MerchantDraft) => Promise<void>; onReload?: () => void }) {
  const [form, setForm] = useState<MerchantDraft>(() => merchantDraft(merchant));
  const [error, setError] = useState<MerchantDraftError>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const persistent = Boolean(onSave);
  const prefix = useId();
  const formElement = useRef<HTMLFormElement>(null);
  let draft = merchant; let valid = false;
  try { draft = applyMerchantDraft(baseline, form); valid = true; } catch { /* Show the last saved draft until settings are valid. */ }
  function update(field: keyof MerchantDraft, value: string) { setForm((current) => ({ ...current, [field]: value })); setSaved(false); setError(undefined); }
  async function save() {
    if (saving) return;
    try {
      const next = applyMerchantDraft(baseline, form);
      setSaving(true); setSaved(false); setError(undefined);
      await onSave?.(merchantDraft(next));
      onApply(next); setForm(merchantDraft(next)); setSaved(true);
    }
    catch (reason) {
      const problem = reason instanceof MerchantDraftError ? reason : new MerchantDraftError('form', persistent && reason instanceof Error ? reason.message : 'Unable to validate the draft.');
      setError(problem); setSaved(false);
      formElement.current?.querySelector<HTMLElement>(`[name="${problem.field}"]`)?.focus();
    } finally { setSaving(false); }
  }
  const describe = (field: keyof MerchantDraft) => error?.field === field ? `${prefix}-${field}-error` : undefined;
  return <>
    <div className="admin-heading"><div><p className="eyebrow">{persistent ? 'Store configuration' : 'Synthetic configuration preview'}</p><h1>Brand & pickup settings</h1></div><span className="settings-badge">{persistent ? 'Database backed' : 'Preview only'}</span></div>
    <p className="settings-boundary">{persistent ? 'Administrator changes are saved to this store database and appear on the storefront after reload. Use synthetic details in this pilot. Payment configuration, media, currency and credentials cannot be edited here.' : 'Use fictional store details. Saving changes this preview tab only. Nothing is sent to an API, written to browser storage, applied to the public store or used to configure credentials.'}</p>
    <div className="settings-layout">
      <form className="admin-card settings-form" ref={formElement} noValidate onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset className="settings-fields" disabled={saving}>
        <legend>{persistent ? 'Store presentation' : 'Make the demo yours'}</legend>
        {error && <p className="admin-error" role="alert">{labels[error.field as keyof MerchantDraft] ?? 'Settings'}: {error.message}</p>}
        {(Object.keys(maximums) as (keyof typeof maximums)[]).map((field) => <label key={field} htmlFor={`${prefix}-${field}`}>
          {labels[field]}
          {field === 'introduction' || field === 'pickupInstructions' ? <textarea id={`${prefix}-${field}`} name={field} rows={3} maxLength={maximums[field]} value={form[field]} onChange={(event) => update(field, event.target.value)} aria-invalid={error?.field === field || undefined} aria-describedby={describe(field)} /> : <input id={`${prefix}-${field}`} name={field} maxLength={maximums[field]} value={form[field]} onChange={(event) => update(field, event.target.value)} aria-invalid={error?.field === field || undefined} aria-describedby={describe(field)} />}
          {error?.field === field && <span className="field-error" id={`${prefix}-${field}-error`}>{error.message}</span>}
        </label>)}
        <div className="settings-colors"><label htmlFor={`${prefix}-accent`}>Accent color<input id={`${prefix}-accent`} name="accent" value={form.accent} maxLength={7} spellCheck={false} onChange={(event) => update('accent', event.target.value)} aria-invalid={error?.field === 'accent' || undefined} aria-describedby={describe('accent')} />{error?.field === 'accent' && <span className="field-error" id={`${prefix}-accent-error`}>{error.message}</span>}</label>
          <label htmlFor={`${prefix}-background`}>Storefront background<select id={`${prefix}-background`} name="background" value={form.background} onChange={(event) => update('background', event.target.value)}>{paperColors.map((color) => <option key={color.value} value={color.value}>{color.label}</option>)}</select></label></div>
        <p className="settings-help">Use #RRGGBB for the accent. Button text selects a readable black or white automatically. Backgrounds use a fixed light palette. USD and pickup remain fixed.</p>
        <div className="settings-actions"><button className="admin-primary" type="submit">{saving ? 'Saving...' : persistent ? 'Save store settings' : 'Save preview draft'}</button><button type="button" onClick={() => { const next = persistent ? merchant : baseline; setForm(merchantDraft(next)); if (!persistent) onApply(next); setSaved(false); setError(undefined); }}>{persistent ? 'Discard unsaved changes' : 'Reset demo settings'}</button>{persistent && <button type="button" onClick={onReload}>Reload saved settings</button>}</div>
        {saved && <p role="status">{persistent ? 'Store settings saved to the database.' : 'Draft saved in this tab only. Reloading restores the original demo.'}</p>}
        </fieldset>
      </form>
      <section className="settings-preview-column" aria-label="Brand preview and setup boundaries">
        <div className="settings-preview-label" role="status">{valid ? saved ? 'Saved draft preview' : 'Live preview of valid draft settings' : 'Showing the last saved settings until the draft is valid'}</div>
        <div className="storefront settings-store-preview" style={merchantTheme(draft)}>
          <div className="preview-brand"><span className="brand"><StoreBrand merchant={draft} /></span><span className="settings-badge">Read-only preview</span></div>
          <ShopHero merchant={draft} preview />
          <div className="preview-pickup"><h2>{draft.pickup.label}</h2><p>{draft.pickup.instructions}</p><span className="preview-action">Example pickup button</span></div>
        </div>
        <section className="admin-card setup-readiness"><h2>Setup status</h2><ul><li><strong>Brand draft:</strong> {valid ? 'valid for this preview' : 'needs changes'}</li><li><strong>Staff sign-in:</strong> {persistent ? 'verified administrator session required for every request' : 'not configured; staff APIs remain closed'}</li><li><strong>Payments:</strong> mock only; real Square acceptance not run</li><li><strong>Mail & workers:</strong> disabled</li><li><strong>Deployment:</strong> this page does not change a Railway service</li></ul><a href={persistent ? '/admin/integration' : '/admin/preview/integration'} onClick={(event) => { if (onOpenSetup && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); onOpenSetup(); } }}>Review the non-secret Square setup guide →</a></section>
        <details className="admin-card settings-export"><summary>View validated presentation settings</summary><p>Presentation values only. This is not a full merchant installation file; credentials and commerce controls are excluded.</p><textarea readOnly rows={12} aria-label="Validated demo presentation settings" value={valid ? JSON.stringify(parseMerchantDraft(form), null, 2) : 'Fix validation errors to view settings.'} /></details>
      </section>
    </div>
  </>;
}
