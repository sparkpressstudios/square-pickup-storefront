import {useEffect,useState} from 'react';
import {CHANGELOG,RELEASE_GUIDE,UPGRADE_GUIDE,type ReleaseStatus} from '../../shared/release-updates';
export function ReleaseDetails({status}:{status:ReleaseStatus}) {
 return <><p><strong>Installed version: {status.installedVersion}</strong></p>
 <p role="status">{status.state==='available'?'A newer release is available for review.':status.state==='current'?'Installed version matches the published release.':status.state==='ahead'?'Installed version is ahead of the published release.':'Release check unavailable. This does not mean you are up to date.'}</p>
 {status.latest&&<><p>Latest published version: {status.latest.version} · Published {status.latest.releasedAt}</p><p>{status.latest.summary}</p><h3>Security notes</h3><p>{status.latest.securityNotes}</p><h3>Migration notes</h3><p>{status.latest.migrationNotes}</p><h3>Acceptance limits</h3><p>{status.latest.acceptanceNotes}</p></>}
 {status.stale&&<p>Cached release details may be stale. Checks retry no more than hourly after failure.</p>}
 <p>Last attempted check: {status.checkedAt??'Not checked'}. Last successful check: {status.lastSuccessfulCheckAt??'None'}.</p>
 </>;
}
export function ReleaseUpdates() {
 const [status,setStatus]=useState<ReleaseStatus>();const [error,setError]=useState(false);
 useEffect(()=>{const controller=new AbortController();void fetch('/api/admin/updates',{credentials:'same-origin',signal:controller.signal}).then(async response=>{if(!response.ok)throw new Error();return response.json() as Promise<ReleaseStatus>;}).then(value=>{if(!controller.signal.aborted)setStatus(value);}).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[]);
 return <section className="admin-card" style={{overflowWrap:'anywhere'}}><h1>Updates</h1>
 {status?<ReleaseDetails status={status}/>:<p role="status">{error?'Unable to check releases. Sign in again or try later; your store is unchanged.':'Checking release information…'}</p>}
 <p>Read-only release notice. No deployment, migration, data or customization changes happen here. Checks are cached for 24 hours; this page does not poll.</p>
 <p>Back up data and configuration, review migration notes, test your customizations, then choose whether to apply an update in Railway. Customized source forks may require a manual merge. A code rollback does not undo payments or database changes.</p>
 <p><a href={CHANGELOG} target="_blank" rel="noopener noreferrer">Changelog</a> · <a href={UPGRADE_GUIDE} target="_blank" rel="noopener noreferrer">Review owner-controlled upgrade instructions</a> · <a href={RELEASE_GUIDE} target="_blank" rel="noopener noreferrer">Release policy and changelog guidance</a></p>
 <p>Existing MIT features remain free. No paid update subscription or premium feature access is implemented here.</p></section>;
}
