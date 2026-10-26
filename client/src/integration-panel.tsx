import { useEffect, useState } from 'react';
import { integrationOwnership, integrationStatus, setupMetadataReady, type IntegrationStatus } from '../../shared/integration';

const failureLabels = {
  WAITING_FOR_PAYMENT: 'Waiting for a verified payment mapping', TRANSIENT_DATABASE: 'Temporary database failure',
  RECONCILIATION_CONFLICT: 'Payment/refund data conflict: investigate before retry', UNEXPECTED_FAILURE: 'Unexpected failure: investigate before retry', ATTEMPTS_EXHAUSTED: 'Retry limit reached',
};
export function IntegrationDetails({ status, canRetry, onRetry }: { status: IntegrationStatus; canRetry: boolean; onRetry?: (id: string) => Promise<void> }) {
  const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  return <><div className="admin-heading"><div><p className="eyebrow">Operations</p><h1>Square connection</h1></div><strong>Not connected</strong></div>
    <section className="admin-card"><h2>Sandbox preparation</h2><p>{status.providerCallsEnabled ? 'Sandbox-only calls explicitly configured; credentials and actual acceptance are unverified. Production payments remain disabled.' : 'Provider calls and automatic sync are disabled. Credentials are not loaded. Real Square acceptance has not run.'}</p><p>Storage: {status.storage === 'native-postgres' ? 'Native PostgreSQL' : status.storage === 'embedded-postgres' ? 'Isolated embedded PostgreSQL' : 'Memory demo'}. Automatic sync and reconciliation worker: disabled.</p></section>
    <section className="admin-card"><h2>Reconciliation visibility</h2><p>These jobs replay already verified, sanitized webhook events. They never create payments, import orders, change stock or send messages.</p>
      {status.reconciliation ? <><div className="admin-metrics">{Object.entries(status.reconciliation.counts).map(([label, count]) => <div key={label}><p>{label === 'attention' ? 'Needs attention' : label}</p><strong>{count}</strong></div>)}</div><p>Pending events: {status.reconciliation.pendingEvents}. Unmapped payments: {status.reconciliation.unknownPayments}. Expired worker leases: {status.reconciliation.expiredLeases}.</p>
        {error && <p role="alert">{error}</p>}<div className="admin-table-wrap"><table><thead><tr><th>Job</th><th>State</th><th>Attempts</th><th>Next eligible time (UTC)</th><th>Issue</th><th>Action</th></tr></thead><tbody>{status.reconciliation.recent.map((job) => <tr key={job.id}><td>{job.id.slice(0, 8)}</td><td>{job.state}</td><td>{job.attempts} / 5</td><td>{job.state === 'retry' || job.state === 'queued' ? job.availableAt : '-'}</td><td>{job.failureCode ? failureLabels[job.failureCode] : '-'}</td><td>{job.state === 'attention' && canRetry && onRetry ? <button type="button" disabled={Boolean(busy)} onClick={() => { setBusy(job.id); setError(''); void onRetry(job.id).catch(() => setError('Unable to requeue this job. Refresh status before trying again.')).finally(() => setBusy('')); }}>{busy === job.id ? 'Requeuing...' : 'Requeue once'}</button> : '-'}</td></tr>)}{status.reconciliation.recent.length === 0 && <tr><td colSpan={6}>No reconciliation jobs recorded.</td></tr>}</tbody></table></div><p>Requeue only after resolving the issue. This does not start a worker or enable provider calls.</p></>
        : <p>Durable reconciliation storage is not configured in this demo view.</p>}
    </section>
    <section className="admin-card"><h2>Who owns each record?</h2><div className="admin-table-wrap"><table><thead><tr><th>Resource</th><th>Source of truth</th><th>Boundary</th></tr></thead><tbody>{integrationOwnership.map((policy) => <tr key={policy.resource}><td>{policy.resource}</td><td>{policy.owner}</td><td>{policy.rule}</td></tr>)}</tbody></table></div></section>
  </>;
}
export function SandboxSetupGuide() {
  const [applicationId, setApplicationId] = useState(''); const [locationId, setLocationId] = useState('');
  const ready = setupMetadataReady({ environment: 'sandbox', applicationId, locationId });
  return <section className="admin-card"><h2>Check non-secret setup details</h2><p>Use the sandbox application ID and test location ID. This form checks their format in this tab only; it does not save settings, verify ownership or connect Square. Do not enter an access token.</p>
    <div className="admin-fields"><label>Sandbox application ID<input autoComplete="off" maxLength={128} value={applicationId} onChange={(event) => setApplicationId(event.target.value)} placeholder="sandbox-sq0idb-..." /></label><label>Test location ID<input autoComplete="off" maxLength={64} value={locationId} onChange={(event) => setLocationId(event.target.value)} /></label></div>
    <p role="status">{ready ? 'Public ID formats look valid. Connection remains unverified.' : 'Enter both sandbox public IDs to check their format.'}</p>
    <ol><li>Keep this merchant sandbox-only, USD and pickup while acceptance is pending.</li><li>Provide the sandbox token through the approved secure local configuration path. Token entry alone does not activate calls.</li><li>Configure trusted staff sign-in and an explicitly reviewed sandbox transport, secure card route and signed webhook delivery.</li><li>Verify a complete sandbox order, recovery/retries and partial refunds before considering production.</li></ol>
  </section>;
}
export function IntegrationPanel({ preview, csrfToken, role }: { preview: boolean; csrfToken: string; role: string }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(preview ? integrationStatus() : null); const [error, setError] = useState(''); const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (preview) { setStatus(integrationStatus()); return; }
    const controller = new AbortController(); setError('');
    void fetch('/api/admin/integration', { signal: controller.signal, credentials: 'same-origin' }).then(async (response) => { if (!response.ok) throw new Error(); const body = await response.json() as IntegrationStatus; if (!controller.signal.aborted) setStatus(body); }).catch(() => { if (!controller.signal.aborted) setError('Integration status is unavailable. Verify staff access and local database health.'); });
    return () => controller.abort();
  }, [preview, refresh]);
  async function retry(id: string) {
    const response = await fetch(`/api/admin/integration/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrfToken } });
    if (!response.ok) throw new Error(); setRefresh((value) => value + 1);
  }
  return <>{preview && <p>Preview status has no connection to local job records.</p>}{error ? <p role="alert">{error}</p> : status ? <IntegrationDetails status={status} canRetry={!preview && role === 'admin'} onRetry={retry} /> : <p role="status">Loading integration status...</p>}
    {!preview && <button type="button" onClick={() => setRefresh((value) => value + 1)}>Refresh status</button>}<SandboxSetupGuide /></>;
}
