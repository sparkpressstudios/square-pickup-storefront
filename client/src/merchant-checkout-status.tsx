/** Read only the persisted activation flag; configuration readiness is not activation. */
export function MerchantCheckoutStatus({enabled,sandbox=false}:{enabled:unknown;sandbox?:boolean}) {
 const known=typeof enabled==='boolean';
 return <p className="settings-badge" role="status">{sandbox?'Sandbox checkout':'Checkout'}: <strong>{known?(enabled?'Open for new orders':'Closed to new orders'):'Status unavailable'}</strong>{enabled===false&&<span> · Existing order status and recovery remain available.</span>}{!known&&<span> · Refresh to verify before taking new orders.</span>}</p>;
}
