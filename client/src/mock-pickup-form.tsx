import { useId, useRef, useState } from 'react';
import { MockPickupError, parseMockPickup, type MockPickupDetails } from '../../shared/mock-pickup';

export function MockPickupForm({ busy, onReady }: { busy: boolean; onReady: (details: MockPickupDetails) => void }) {
  const id = useId();
  const [name, setName] = useState('Demo Shopper');
  const [email, setEmail] = useState('shopper@example.invalid');
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<MockPickupError>();
  const form = useRef<HTMLFormElement>(null);
  return <form className="mock-pickup-form" ref={form} noValidate onSubmit={(event) => {
    event.preventDefault(); if (busy) return;
    try { const details = parseMockPickup({ name, email, acknowledged }); setError(undefined); onReady(details); }
    catch (reason) { const problem = reason instanceof MockPickupError ? reason : new MockPickupError('form', 'Check the fictional pickup fields.'); setError(problem); form.current?.querySelector<HTMLElement>(`[name="${problem.field}"]`)?.focus(); }
  }}>
    <h3>Fictional shopper details</h3><p id={`${id}-help`}>Use synthetic details only. They stay in this tab and are never sent to the server, Square or email. Reloading clears this contact preview.</p>
    <label htmlFor={`${id}-name`}>Fictional name<input id={`${id}-name`} name="name" maxLength={100} autoComplete="off" value={name} disabled={busy} onChange={(event) => setName(event.target.value)} aria-invalid={error?.field === 'name' || undefined} aria-describedby={`${id}-help${error?.field === 'name' ? ` ${id}-error` : ''}`} /></label>
    <label htmlFor={`${id}-email`}>Fictional email<input id={`${id}-email`} name="email" type="email" maxLength={80} autoComplete="off" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} aria-invalid={error?.field === 'email' || undefined} aria-describedby={`${id}-help${error?.field === 'email' ? ` ${id}-error` : ''}`} /></label>
    <label className="mock-acknowledgment" htmlFor={`${id}-acknowledged`}><input id={`${id}-acknowledged`} name="acknowledged" type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAcknowledged(event.target.checked)} aria-invalid={error?.field === 'acknowledged' || undefined} aria-describedby={error?.field === 'acknowledged' ? `${id}-error` : undefined} /><span>I understand this is a simulation. No real order or pickup reservation will be created.</span></label>
    {error && <p id={`${id}-error`} className="cart-error" role="alert">{error.message}</p>}
    <button type="submit" className="primary-action" disabled={busy}>{busy ? 'Checking price & stock…' : 'Choose pickup & review'}</button>
  </form>;
}
