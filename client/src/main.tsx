import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Storefront } from '../../shared/storefront';
import { CatalogPage } from './catalog-page';
import { MerchantStorefront, type MerchantStorefrontData } from './merchant-storefront';
import './merchant-commerce.css';
import './styles.css';
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-600.css';
import '@fontsource/poppins/latin-700.css';
import '@fontsource/roboto-slab/latin-600.css';
import '@fontsource/roboto-slab/latin-900.css';
import { AdminApp } from './admin';
import './admin.css';

function App() {
  const [storefront, setStorefront] = useState<Storefront | MerchantStorefrontData>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/storefront', { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error('Catalog unavailable');
      setStorefront(await response.json() as Storefront | MerchantStorefrontData);
    }).catch((error: unknown) => { if (!(error instanceof DOMException && error.name === 'AbortError')) setFailed(true); });
    return () => controller.abort();
  }, []);
  if (failed) return <main className="message"><h1>The catalog is taking a moment.</h1><p>Check the local server and reload to try again.</p></main>;
  if (!storefront) return <main className="message" role="status">Opening the studio…</main>;
  return storefront.mode === 'synthetic-demo' ? <CatalogPage storefront={storefront} /> : <MerchantStorefront storefront={storefront} />;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/') ? <AdminApp /> : <App />}</StrictMode>);

