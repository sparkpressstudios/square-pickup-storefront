import { useEffect, useState, type FormEvent } from 'react';

/** A real merchant-only sign-in. No password is saved locally or sent to the demo checkout. */
export function MerchantLoginPanel({ onSignedIn }: { onSignedIn: () => void }) {
  const [available,setAvailable] = useState<boolean | null>(null);
  const [password,setPassword] = useState('');
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {
    const controller=new AbortController();
    void fetch('/api/merchant-auth/status',{credentials:'same-origin',signal:controller.signal})
      .then(async response=>{
        if(!response.ok)throw new Error();
        const body=await response.json() as {enabled?:unknown};
        if(!controller.signal.aborted)setAvailable(body.enabled===true);
      }).catch(()=>{if(!controller.signal.aborted)setAvailable(false);});
    return ()=>controller.abort();
  },[]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !available || password.length < 16 || password.length > 128) return;
    setBusy(true);setError('');
    try {
      const response=await fetch('/api/merchant-auth/login',{
        method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({password}),
      });
      if (!response.ok) {
        if (response.status===429)throw new Error('Too many sign-in attempts. Try again later.');
        throw new Error('Unable to sign in. Check your credentials.');
      }
      setPassword('');
      onSignedIn();
    }catch(reason){
      setPassword('');
      setError(reason instanceof Error ? reason.message : 'Unable to sign in.');
    }finally{setBusy(false);}
  }
  return <><div className="admin-heading"><div><p className="eyebrow">Merchant administration</p><h1>Sign in</h1></div><strong>{available?'Secure staff session':'Unavailable'}</strong></div>
    <section className="admin-card">
      <h2>Administrator access</h2>
      <p>For a separately provisioned merchant installation. Sign-in uses a protected, expiring server session; passwords are never stored in the browser.</p>
      {available===null && <p role="status">Checking merchant sign-in configuration…</p>}
      {available===false && <p role="status">Administrator sign-in is not configured in this synthetic sandbox. Existing product and payment previews remain available.</p>}
      {available===true && <form onSubmit={submit}>
        <label>Administrator password<input type="password" autoComplete="current-password" required minLength={16} maxLength={128}
          value={password} disabled={busy} onChange={event=>setPassword(event.target.value)} /></label>
        {error && <p role="alert">{error}</p>}
        <button className="admin-primary" type="submit" disabled={busy || password.length<16}>{busy?'Signing in…':'Sign in securely'}</button>
      </form>}
    </section></>;
}
