import { ReleaseUpdates } from './release-updates';
import { MerchantOperations } from './merchant-operations';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { demoCatalog } from '../../config/demo-catalog';
import { merchant as defaultMerchant } from '../../config/merchant';
import type { MerchantConfig } from '../../shared/storefront';
import { applyProductEdit, type EditableProduct, type ProductEditRequest } from '../../shared/admin-catalog';
import { formatPrice, validateCatalog, type Product } from '../../shared/catalog';
import { activeAdminHref, catalogSummary, filterProducts, formRequest, productForm } from './admin-model';
import { IntegrationPanel } from './integration-panel';
import { MerchantImportPanel } from './merchant-import-panel';
import { MerchantLoginPanel } from './merchant-login-panel';
import { SquareServicesPanel } from './square-services-panel';
import { MerchantSettingsEditor, MerchantSettingsPreview } from './merchant-settings';
import { applyMerchantDraft, type MerchantDraft } from '../../shared/merchant-draft';
import type { EditableMerchantSettings } from '../../shared/merchant-settings';
import { merchantTheme, StoreBrand } from './storefront-brand';

type Navigate = (href: string) => void;
function AdminLink({ href, navigate, children, current }: { href: string; navigate: Navigate; children: ReactNode; current?: boolean }) {
  return <a href={href} aria-current={current ? 'page' : undefined} onClick={(event) => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(href); } }}>{children}</a>;
}
/** Grouped navigation/mobile shell adapted from the reviewed source AdminLayout. */
export function AdminLayout({ path, root, navigate, children, preview, branding = defaultMerchant, onSignOut, commerceAvailable = false, updatesAvailable = false, paymentEnvironment='sandbox' }: { path: string; root: string; navigate: Navigate; children: ReactNode; preview: boolean; branding?: MerchantConfig; commerceAvailable?:boolean; updatesAvailable?:boolean; paymentEnvironment?:'sandbox'|'production'; onSignOut?: () => void }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  const closeNavigation = () => { setSidebarOpen(false); window.requestAnimationFrame(() => menuButton.current?.focus()); };
  useEffect(() => {
    const query = window.matchMedia('(max-width: 720px)');
    const update = () => { setNarrow(query.matches); if (!query.matches) setSidebarOpen(false); };
    update(); query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!sidebarOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    sidebar.current?.querySelector<HTMLElement>('a,button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeNavigation(); }
      if (event.key === 'Tab') {
        const items = sidebar.current?.querySelectorAll<HTMLElement>('a[href],button:not(:disabled)');
        const first = items?.[0]; const last = items?.[items.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    const resize = () => { if (window.innerWidth > 720) setSidebarOpen(false); };
    document.addEventListener('keydown', keydown); window.addEventListener('resize', resize);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', keydown); window.removeEventListener('resize', resize); };
  }, [sidebarOpen]);
  const groups = commerceAvailable?[{heading:'Merchant',items:[{href:root,label:'Setup, stock & orders'},{href:`${root}/import`,label:'Import Square products'}]}]:[{ heading: 'Overview', items: [{ href: root, label: 'Dashboard' }] }, { heading: 'Catalog', items: [{ href: `${root}/products`, label: 'Products' }, { href: `${root}/import`, label: 'Import products' }] }, { heading: 'Operations', items: [...(commerceAvailable ? [{ href: `${root}/commerce`, label: 'Stock & orders' }] : []), { href: `${root}/integration`, label: 'Square connection' }, { href: `${root}/square-services`, label: 'Square services' }] }, { heading: 'System', items: [{ href: `${root}/settings`, label: 'Brand & pickup' }] }];
  if (!preview && updatesAvailable) groups.push({heading:'Releases',items:[{href:`${root}/updates`,label:'Updates'}]});
  const active = activeAdminHref(path, groups.flatMap((group) => group.items.map((item) => item.href)), root);
  return <div className="admin-app" style={{ ...merchantTheme(branding), ...(branding.media?.hero ? { backgroundImage: `linear-gradient(#111118d9, #111118ee), url("${branding.media.hero}")` } : {}) }}>
    {sidebarOpen && <button className="admin-backdrop" aria-label="Close navigation" onClick={closeNavigation} />}
    <aside ref={sidebar} id="admin-navigation" inert={narrow && !sidebarOpen} role={narrow && sidebarOpen ? 'dialog' : undefined} aria-modal={narrow && sidebarOpen ? true : undefined} className={`admin-sidebar ${sidebarOpen ? 'open' : ''}`} aria-label="Administration">
      <a className="admin-brand" href="/"><StoreBrand merchant={branding} /></a>
      <button type="button" className="admin-nav-close" onClick={closeNavigation}>Close navigation</button>
      <nav>{groups.map((group) => <div key={group.heading}><p>{group.heading}</p>{group.items.map((item) => <AdminLink key={item.href} href={item.href} current={active === item.href} navigate={(href) => { setSidebarOpen(false); navigate(href); }}>{item.label}</AdminLink>)}</div>)}</nav>
      <a className="admin-store-link" href="/">View storefront</a>
    </aside>
    <div className="admin-body" inert={narrow && sidebarOpen}><header className="admin-topbar"><button ref={menuButton} type="button" className="admin-menu" aria-controls="admin-navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>Menu</button><span>{preview ? 'Draft preview' : 'Store administration'}</span><span>USD / Pickup {onSignOut && <button type="button" onClick={onSignOut}>Sign out</button>}</span></header>
      <main className="admin-content"><div className="admin-notice">{preview ? 'Synthetic draft preview. Changes stay in this tab and reset on reload; they do not change the storefront or database.' : paymentEnvironment==='production'?'Production payment mode is configured. Successful charges, refunds and pickup changes affect the connected merchant.':'Sandbox payments and pickup are tests. Production payments, customer email and schedulers remain disabled.'}</div>{children}</main>
    </div>
  </div>;
}
export function AdminDashboard({ products, root, navigate }: { products: readonly Product[]; root: string; navigate: Navigate }) {
  const summary = catalogSummary(products);
  return <><div className="admin-heading"><div><p className="eyebrow">Your store at a glance</p><h1>Dashboard</h1></div><AdminLink href={`${root}/products`} navigate={navigate}>Manage products</AdminLink></div>
    <div className="admin-metrics">{Object.entries(summary).map(([label, count]) => <article className="admin-card" key={label}><p>{label === 'soldOut' ? 'Sold-out variants' : label === 'available' ? 'Available variants' : label}</p><strong>{count}</strong></article>)}</div>
    <section className="admin-card"><h2>A shared catalog for food and non-food</h2><p>Products have their own options, prices and availability. The catalog in this app owns stock; automatic Square POS inventory synchronization is not implemented.</p><p>Sales, customers, events and fulfillment reporting are outside this checkpoint.</p></section></>;
}
/** Search/table/edit flow adapted from ProductList; unsupported bulk/delete actions excluded. */
export function AdminProductList({ products, root, navigate }: { products: readonly Product[]; root: string; navigate: Navigate }) {
  const [search, setSearch] = useState('');
  const filtered = filterProducts(products, search);
  return <><div className="admin-heading"><div><p className="eyebrow">Catalog</p><h1>Products</h1></div><span>{products.length} products</span></div>
    <section className="admin-card"><label className="admin-search">Search products<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by name" /></label>
      <div className="admin-table-wrap"><table><thead><tr><th>Name</th><th>Category</th><th>Price from</th><th>Variants</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{filtered.map((product) => <tr key={product.id}><td><AdminLink href={`${root}/products/${product.id}`} navigate={navigate}>{product.name}</AdminLink><p>{product.description}</p></td><td>{product.category}</td><td>{formatPrice(Math.min(...product.variants.map((variant) => variant.priceMinor)), 'USD')}</td><td>{product.variants.length}</td><td>{product.variants.some((variant) => variant.enabled) ? 'Active' : 'Inactive'}</td><td><AdminLink href={`${root}/products/${product.id}`} navigate={navigate}>Edit</AdminLink></td></tr>)}
          {filtered.length === 0 && <tr><td colSpan={6}>No products match your search.</td></tr>}</tbody></table></div>
    </section></>;
}
/** Controlled metadata + variant rows adapt the source ProductEdit workflow, with strict money/stock parsing. */
export function AdminProductEdit({ entry, preview, onSave, onReload, root, navigate }: { entry: EditableProduct; preview: boolean; onSave: (request: ProductEditRequest) => Promise<void>; onReload: () => void; root: string; navigate: Navigate }) {
  const [form, setForm] = useState(() => productForm(entry.product));
  const [saving, setSaving] = useState(false); const [error, setError] = useState(''); const [saved, setSaved] = useState(false);
  const product = entry.product;
  function updateVariant(index: number, update: Partial<typeof form.variants[number]>) { setSaved(false); setForm({ ...form, variants: form.variants.map((variant, i) => i === index ? { ...variant, ...update } : variant) }); }
  return <form onSubmit={(event) => { event.preventDefault(); if (saving) return; setError(''); setSaved(false); let request: ProductEditRequest;
    try { request = formRequest(form, entry.revision); } catch (reason) { setError((reason as Error).message); return; }
    setSaving(true); void onSave(request).then(() => setSaved(true)).catch((reason: Error) => setError(reason.message)).finally(() => setSaving(false));
  }}>
    <AdminLink href={`${root}/products`} navigate={navigate}>Back to products</AdminLink>
    <div className="admin-heading"><div><p className="eyebrow">Product editor</p><h1>Edit: {product.name}</h1></div><button className="admin-primary" disabled={saving} type="submit">{saving ? 'Saving...' : preview ? 'Save draft' : 'Update product'}</button></div>
    {error && <div className="admin-error" role="alert">{error} <button type="button" onClick={onReload} disabled={saving}>Discard edits and reload</button></div>}
    {saved && <p role="status">{preview ? 'Draft saved in this tab.' : 'Product updated.'}</p>}
    <fieldset disabled={saving} className="admin-card admin-fields"><legend>Product data</legend>
      <label>Name<input required maxLength={160} value={form.name} onChange={(event) => { setSaved(false); setForm({ ...form, name: event.target.value }); }} /></label>
      <label>Category<input required maxLength={80} value={form.category} onChange={(event) => { setSaved(false); setForm({ ...form, category: event.target.value }); }} /></label>
      <label className="admin-wide">Description<textarea required maxLength={2000} rows={3} value={form.description} onChange={(event) => { setSaved(false); setForm({ ...form, description: event.target.value }); }} /></label>
    </fieldset>
    <fieldset disabled={saving} className="admin-card"><legend>Variants</legend><p>Prices are USD. Stock is the quantity available for new carts, excluding existing reservations. SKU and option definitions are read-only in this checkpoint.</p>
      <div className="admin-table-wrap"><table><thead><tr><th>Options / SKU</th><th>Price (USD)</th><th>Available units</th><th>Enabled</th></tr></thead><tbody>{form.variants.map((variant, index) => {
        const original = product.variants.find((item) => item.id === variant.id)!;
        const label = product.options.map((option) => `${option.label}: ${original.selections[option.id]}`).join(' / ') || 'Standard';
        return <tr key={variant.id}><td>{label}<p>{original.sku}</p></td><td><input aria-label={`Price: ${original.sku}`} required inputMode="decimal" value={variant.price} onChange={(event) => updateVariant(index, { price: event.target.value })} /></td><td><input aria-label={`Stock: ${original.sku}`} required inputMode="numeric" value={variant.stock} onChange={(event) => updateVariant(index, { stock: event.target.value })} /></td><td><input aria-label={`Enabled: ${original.sku}`} type="checkbox" checked={variant.enabled} onChange={(event) => updateVariant(index, { enabled: event.target.checked })} /></td></tr>;
      })}</tbody></table></div>
    </fieldset>
  </form>;
}
async function jsonResponse(response: Response) {
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message ?? 'Unable to load staff catalog.');
  return body;
}
export function AdminApp() {
  const [path, setPath] = useState(window.location.pathname);
  const preview = path === '/admin/preview' || path.startsWith('/admin/preview/');
  const root = preview ? '/admin/preview' : '/admin';
  const [commerceEnabled,setCommerceEnabled]=useState(false);const [paymentEnvironment,setPaymentEnvironment]=useState<'sandbox'|'production'>('sandbox');
  const [entries, setEntries] = useState<EditableProduct[]>([]); const [csrf, setCsrf] = useState(''); const [role, setRole] = useState(''); const [merchantAuthEnabled, setMerchantAuthEnabled] = useState(false); const [merchantImportEnabled, setMerchantImportEnabled] = useState(false); const [squareServicesEnabled, setSquareServicesEnabled] = useState(false); const [error, setError] = useState(''); const [generation, setGeneration] = useState(0);
  const [branding, setBranding] = useState<MerchantConfig>(defaultMerchant);
  const [storedSettings, setStoredSettings] = useState<EditableMerchantSettings>();
  useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop); }, []);
  const navigate: Navigate = (href) => { window.history.pushState(null, '', href); setPath(href); };
  useEffect(() => { const controller = new AbortController();
    void fetch('/api/merchant-auth/status', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => { if (!response.ok) return; const body = await response.json() as { enabled?: boolean };
        if (!controller.signal.aborted) setMerchantAuthEnabled(body.enabled === true); }).catch(() => {});
    return () => controller.abort(); }, []);
  useEffect(() => {
    setError(''); setEntries([]); setCsrf(''); setRole(''); setMerchantImportEnabled(false); setSquareServicesEnabled(false); setStoredSettings(undefined);
    if (preview) { setEntries(structuredClone(demoCatalog.products).map((product) => ({ product, revision: '0'.repeat(64) }))); return; }
    const controller = new AbortController();
    void fetch('/api/admin/session', { signal: controller.signal, credentials: 'same-origin' }).then(jsonResponse).then(async (session: { csrfToken: string; catalogEditing: boolean; settingsEditing: boolean; merchantImportEnabled?: boolean; squareServicesEnabled?: boolean; merchantCommerceEnabled?:boolean; paymentEnvironment?:'sandbox'|'production'; role: string }) => {
      if (!controller.signal.aborted) { setCommerceEnabled(session.merchantCommerceEnabled===true);setPaymentEnvironment(session.paymentEnvironment==='production'?'production':'sandbox'); setCsrf(session.csrfToken); setRole(session.role); setMerchantImportEnabled(session.merchantImportEnabled === true); setSquareServicesEnabled(session.squareServicesEnabled === true); }
      if(session.merchantCommerceEnabled){if(!controller.signal.aborted)setBranding({...defaultMerchant,name:'Store administration',descriptor:'Merchant identity unavailable',tagline:'Merchant storefront',introduction:'',media:undefined});const storefront=await jsonResponse(await fetch('/api/storefront',{signal:controller.signal,credentials:'same-origin'}));if(!controller.signal.aborted&&(storefront.mode==='merchant-sandbox'||storefront.mode==='merchant-production'))setBranding(storefront.merchant as MerchantConfig);}
      else if (session.settingsEditing && session.role === 'admin') {
        const saved = await jsonResponse(await fetch('/api/admin/settings', { signal: controller.signal, credentials: 'same-origin' })) as EditableMerchantSettings;
        if (!controller.signal.aborted) { setStoredSettings(saved); setBranding(applyMerchantDraft(defaultMerchant, saved.settings)); }
      } else if (!controller.signal.aborted) setBranding(defaultMerchant);
      if (!session.catalogEditing) return;
      const catalog = await jsonResponse(await fetch('/api/admin/products', { signal: controller.signal, credentials: 'same-origin' }));
      if (!controller.signal.aborted) { setCsrf(session.csrfToken); setRole(session.role); setEntries(catalog.products as EditableProduct[]); }
    }).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [preview, generation]);
  const reload = () => setGeneration((value) => value + 1);
  async function saveSettings(settings: MerchantDraft) {
    if (!storedSettings || preview || role !== 'admin') throw new Error('Verified administrator and database settings are required.');
    const saved = await jsonResponse(await fetch('/api/admin/settings', { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ settings, revision: storedSettings.revision }) })) as EditableMerchantSettings;
    setStoredSettings(saved);
  }
  async function save(entry: EditableProduct, request: ProductEditRequest) {
    let updated: EditableProduct;
    if (preview) {
      const product = applyProductEdit(entry.product, request);
      validateCatalog({ currency: 'USD', products: entries.map((item) => item.product.id === product.id ? product : item.product) });
      updated = { product, revision: '0'.repeat(64) };
    } else {
      updated = await jsonResponse(await fetch(`/api/admin/products/${encodeURIComponent(entry.product.id)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(request) })) as EditableProduct;
    }
    setEntries((current) => current.map((item) => item.product.id === updated.product.id ? updated : item));
  }
  const productId = path.startsWith(`${root}/products/`) ? path.slice(`${root}/products/`.length) : null;
  const entry = entries.find((item) => item.product.id === productId);
  async function signOut() {
    const response = await fetch('/api/merchant-auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf } });
    if (!response.ok) { setError('Unable to sign out. Contact the administrator before using this session again.'); return; }
    setRole(''); setCsrf(''); setEntries([]); setMerchantImportEnabled(false); setSquareServicesEnabled(false);
    navigate('/admin/login'); reload();
  }
  return <AdminLayout path={path} root={root} preview={preview} navigate={navigate} branding={branding} commerceAvailable={commerceEnabled} updatesAvailable={role === 'admin'} paymentEnvironment={paymentEnvironment} onSignOut={!preview && role === 'admin' && merchantAuthEnabled ? () => { void signOut(); } : undefined}>
    {!preview && role === 'admin' && path === root && <section className="admin-card"><h2>Template updates</h2><p>Review release notices and owner-controlled upgrade instructions. Your data and customizations are not changed by checking.</p><AdminLink href={`${root}/updates`} navigate={navigate}>Open Updates</AdminLink></section>}
    {path === '/admin/login' ? <MerchantLoginPanel onSignedIn={() => { navigate('/admin'); reload(); }} />
      : error ? <section className="admin-card"><h1>Staff access unavailable</h1><p role="alert">{error}</p><p>This demo does not create staff accounts automatically.</p><a href="/admin/login">Open merchant sign-in</a> · <a href="/admin/preview">Open synthetic draft preview</a></section>
      : path === `${root}/updates` && !preview && role === 'admin' ? <ReleaseUpdates />
      : commerceEnabled&&role==='admin'&&[root,`${root}/settings`,`${root}/products`,`${root}/commerce`].includes(path)?<MerchantOperations csrfToken={csrf} environment={paymentEnvironment} onMerchantChange={setBranding}/>
      : path === `${root}/settings` && preview ? <MerchantSettingsPreview merchant={branding} baseline={defaultMerchant} onApply={setBranding} onOpenSetup={() => navigate(`${root}/integration`)} />
      : path === `${root}/settings` && storedSettings && role === 'admin' ? <MerchantSettingsEditor key={generation} merchant={branding} baseline={defaultMerchant} onApply={setBranding} onSave={saveSettings} onReload={reload} onOpenSetup={() => navigate(`${root}/integration`)} />
      : path === `${root}/settings` && role ? <section className="admin-card"><h1>Store settings unavailable</h1><p>Database-backed settings require a verified administrator and a configured settings store.</p><a href="/admin/preview/settings">Open synthetic settings preview</a></section>
      : path === `${root}/integration` && (preview || role) ? <IntegrationPanel preview={preview} csrfToken={csrf} role={role} />
      : path === `${root}/import` && (preview || role) ? <MerchantImportPanel preview={preview} role={role} enabled={merchantImportEnabled} csrfToken={csrf} commerceAvailable={commerceEnabled} />
      : path === `${root}/commerce` ? commerceEnabled && role==='admin' ? <MerchantOperations csrfToken={csrf} environment={paymentEnvironment} onMerchantChange={setBranding} /> : <section className="admin-card"><h1>Merchant commerce unavailable</h1><p>This requires the separate, explicitly configured merchant installation. Synthetic demo checkout remains separate.</p></section>
      : path === `${root}/square-services` && (preview || role) ? <SquareServicesPanel preview={preview} role={role} enabled={squareServicesEnabled} csrfToken={csrf} />
      : entries.length === 0 ? <p role="status">{role ? 'A local catalog editor has not been configured.' : 'Loading catalog...'}</p>
      : productId ? entry ? <AdminProductEdit key={`${entry.product.id}:${generation}`} entry={entry} preview={preview} onSave={(request) => save(entry, request)} onReload={reload} root={root} navigate={navigate} /> : <p>Product not found.</p>
      : path === `${root}/products` ? <AdminProductList products={entries.map((item) => item.product)} root={root} navigate={navigate} />
      : path === root ? <AdminDashboard products={entries.map((item) => item.product)} root={root} navigate={navigate} /> : <p>Page not found.</p>}
  </AdminLayout>;
}

