import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MerchantCheckoutStatus} from '../client/src/merchant-checkout-status';
import {MerchantImportPanel} from '../client/src/merchant-import-panel';
import {MerchantStorefront} from '../client/src/merchant-storefront';
import {AdminLayout} from '../client/src/admin';
import {merchant} from '../config/merchant';
import {demoCatalog} from '../config/demo-catalog';
const render=(value:ReturnType<typeof createElement>)=>renderToStaticMarkup(value);
test('checkout badge distinguishes explicit persisted flags from readiness and unknown data',()=>{
 assert.match(render(createElement(MerchantCheckoutStatus,{enabled:true,sandbox:true})),/Sandbox checkout.*Open for new orders/);
 assert.match(render(createElement(MerchantCheckoutStatus,{enabled:false})),/Closed to new orders.*Existing order status and recovery remain available/);
 for(const enabled of [undefined,null,'true',{ready:true}]){const html=render(createElement(MerchantCheckoutStatus,{enabled}));assert.match(html,/Status unavailable/);assert.doesNotMatch(html,/Open for new orders|Closed to new orders/);}
});
test('merchant importer points to separate activation while legacy preview never promises checkout',()=>{
 const props={preview:false,role:'admin',enabled:true,csrfToken:'unit-only'};
 const live=render(createElement(MerchantImportPanel,{...props,commerceAvailable:true}));assert.match(live,/Importing does not open checkout/);assert.match(live,/href="\/admin\/commerce"/);assert.doesNotMatch(live,/permanently disabled/);
 const legacy=render(createElement(MerchantImportPanel,props));assert.match(legacy,/Checkout is unavailable in this catalog-only workflow/);
 const preview=render(createElement(MerchantImportPanel,{...props,preview:true}));assert.match(preview,/synthetic admin preview/);assert.doesNotMatch(preview,/Fresh merchant setup/);
});
test('same configured brand is rendered in admin and public shell; closed public checkout is explicit',()=>{
 const branding={...merchant,name:'Reviewed Store Identity',tagline:'Reviewed store tagline'};
 const admin=render(createElement(AdminLayout,{path:'/admin',root:'/admin',navigate:()=>{},preview:false,branding,commerceAvailable:true,children:null}));
 const publicHtml=render(createElement(MerchantStorefront,{storefront:{mode:'merchant-sandbox',merchant:branding,catalog:demoCatalog,checkoutEnabled:false,sandbox:{environment:'sandbox',applicationId:'sandbox-sq0idb-onboarding',locationId:'LOCATION'}}}));
 for(const html of [admin,publicHtml])assert.match(html,/Reviewed Store Identity/);
 assert.match(publicHtml,/Sandbox checkout.*Closed to new orders/);assert.match(publicHtml,/No live payments/);
 assert.match(admin,/Setup, stock &amp; orders/);assert.match(admin,/aria-controls="admin-navigation"/);
});
