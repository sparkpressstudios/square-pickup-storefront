import { useEffect, useState } from 'react';
import type { MerchantImportReview, MerchantImportStatus, InventoryOwner } from '../../server/src/merchant-catalog-import';
import { formatPrice } from '../../shared/catalog';

async function result(response: Response): Promise<any> {
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || 'Import request unavailable.');
  return value;
}
/** Existing staff session + CSRF are required. No standalone admin login or secret handling. */
export function MerchantImportPanel({ preview, role, enabled, csrfToken, commerceAvailable = false }: {
  preview: boolean; role: string; enabled: boolean; csrfToken: string; commerceAvailable?: boolean;
}) {
  const [owner, setOwner] = useState<InventoryOwner>('square');
  const [state, setState] = useState<MerchantImportStatus | null>(null);
  const [batch, setBatch] = useState<MerchantImportReview | null>(null);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const active = !preview && role === 'admin' && enabled;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch('/api/admin/merchant-import/status', { credentials: 'same-origin', signal: controller.signal })
      .then(result).then((value: MerchantImportStatus) => {
        if (!controller.signal.aborted) setState(value);
      }).catch(() => {
        if (!controller.signal.aborted) setError('Merchant import status unavailable. Verify the separate database and trusted staff session.');
      });
    return () => controller.abort();
  }, [active, refresh]);
  async function operation(path: string, body: unknown) {
    const response = await fetch('/api/admin/merchant-import/' + path, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body),
    });
    return result(response);
  }
  function stage() {
    if (busy || !active) return;
    setBusy(true); setError(''); setApproved(false); setBatch(null);
    void operation('stage', { inventoryOwner: owner })
      .then((value: MerchantImportReview) => { setBatch(value); setRefresh(v => v + 1); })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(false));
  }
  function inspect(fingerprint: string) {
    if (busy || !active) return;
    setBusy(true); setError(''); setApproved(false);
    void fetch('/api/admin/merchant-import/batches/' + encodeURIComponent(fingerprint), { credentials: 'same-origin' })
      .then(result).then((value: MerchantImportReview) => setBatch(value))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setBusy(false));
  }
  function commit() {
    if (!active || busy || !approved || batch?.state !== 'staged') return;
    setBusy(true); setError('');
    void operation('batches/' + encodeURIComponent(batch.fingerprint) + '/commit', {
      approval: 'approve-disabled-merchant-import-v1',
    }).then((receipt: { state: 'staged' | 'committed'; checkoutEnabled: false }) => {
      if (receipt.state !== 'committed' || receipt.checkoutEnabled !== false) throw new Error('The import completion receipt was not verified.');
      setBatch({ ...batch, state: 'committed' }); setApproved(false); setRefresh(v => v + 1);
    }).catch((reason: Error) => setError(reason.message)).finally(() => setBusy(false));
  }
  return <>
    <div className="admin-heading"><div><p className="eyebrow">Catalog / Square</p><h1>Import products</h1></div>
      <strong>{active ? 'Fresh merchant setup' : 'Not connected'}</strong></div>
    <section className="admin-card">
      <h2>One-way import with inventory protection</h2>
      <p>This workflow discovers an existing Square catalog, stages a reviewable copy, then requires administrator approval before importing. Products remain <strong>disabled with zero stock</strong>. It does not replace existing products, synchronize stock or enable customer checkout.</p>
      {!active && <p role="status">{preview ? 'This is the synthetic admin preview. No merchant database, Square import or staff identity is connected to this screen.' : 'Only verified administrators with a separate initialized merchant database can use this workflow. The current synthetic store does not enable it.'}</p>}
      {error && <p className="admin-error" role="alert">{error}</p>}
      {active && <><p>Database: {state?.mode === 'fresh-merchant-database' ? 'Verified merchant-only data' : 'Checking'} · Imported products: {state?.productCount ?? '—'}.</p><p>{commerceAvailable ? <>Importing does not open checkout. Review stock and the current checkout status in <a href="/admin/commerce">Setup, stock &amp; orders</a>.</> : 'Checkout is unavailable in this catalog-only workflow. A separately configured merchant commerce runtime is required.'}</p>
        <label>Who controls inventory?
          <select value={owner} disabled={busy || (state?.inventoryOwner !== undefined && state.inventoryOwner !== 'unassigned')} onChange={e => { setApproved(false); setOwner(e.target.value as InventoryOwner); }}>
            <option value="square">Square POS controls inventory</option>
            <option value="website">Website controls inventory</option>
          </select>
        </label>
        <p>Choose this deliberately: after the first import, inventory ownership cannot be changed automatically.</p>
        <button type="button" className="admin-primary" disabled={busy || !state || state.inventoryOwner !== 'unassigned'} onClick={stage}>{busy ? 'Processing…' : 'Fetch & stage Square catalog'}</button>
      </>}
    </section>
    {active && state && state.batches.length > 0 && <section className="admin-card">
      <h2>Previous review batches</h2><p>Open the exact saved batch fingerprint before approving anything.</p>
      <div className="admin-table-wrap"><table><thead><tr><th>Batch fingerprint</th><th>Products</th><th>Owner</th><th>State</th><th>Review</th></tr></thead><tbody>{state.batches.map(item =>
        <tr key={item.fingerprint}><td><code>{item.fingerprint.slice(0, 16)}…</code></td><td>{item.productCount}</td><td>{item.inventoryOwner}</td><td>{item.state}</td><td><button type="button" disabled={busy} onClick={() => inspect(item.fingerprint)}>Inspect</button></td></tr>)}</tbody></table></div>
    </section>}
    {active && batch && <section className="admin-card">
      <h2>Review the staged import</h2>
      <p>Batch: <code>{batch.fingerprint}</code></p>
      <p>{batch.productCount} products, {batch.variantCount} variations, {batch.reviewHolds} held Square items excluded. Source of inventory: {batch.inventoryOwner}. All product stock will stay at zero and selling stays disabled.</p>
      <div className="admin-table-wrap"><table><thead><tr><th>Product</th><th>Category</th><th>Square variation</th><th>SKU</th><th>Unit price</th><th>Publish</th></tr></thead><tbody>{batch.products.flatMap(product =>
        product.variations.map(variation =>
          <tr key={variation.squareVariationId}><td>{product.name}</td><td>{product.category}</td><td><code>{variation.squareVariationId}</code></td><td>{variation.sku}</td><td>{formatPrice(variation.priceMinor, 'USD')}</td><td>Disabled / 0 stock</td></tr>))}</tbody></table></div>
      {batch.state === 'committed' ? <p role="status">This exact batch was already committed. Replay is safe and no checkout has been enabled.</p> :
        <>
          <label><input type="checkbox" checked={approved} disabled={busy} onChange={e => setApproved(e.target.checked)} /> I reviewed this exact batch, excluded held items, and approve a one-time disabled, zero-stock import. No checkout or inventory sync will be enabled.</label>
          <button type="button" className="admin-primary" disabled={!approved || busy} onClick={commit}>{busy ? 'Committing…' : 'Commit disabled products'}</button>
        </>}
    </section>}
  </>;
}

