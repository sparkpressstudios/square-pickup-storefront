import { readFileSync } from 'node:fs';
import type { ReleaseManifest, ReleaseStatus } from '../../shared/release-updates';
const MANIFEST = 'https://raw.githubusercontent.com/sparkpressstudios/square-pickup-storefront/main/releases/latest.json';
const DAY = 24 * 60 * 60 * 1000;
const MAX_BYTES = 8192;
export const installedVersion: string = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
function parseVersion(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match || value.length > 100) throw new Error('Invalid version');
  const pre = match[4]?.split('.');
  if (pre?.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) throw new Error('Invalid prerelease');
  return { core: match.slice(1,4).map(v => BigInt(v!)), pre };
}
export function compareVersions(a: string,b: string): number {
  const x=parseVersion(a), y=parseVersion(b);
  for(let i=0;i<3;i++) if(x.core[i]!==y.core[i]) return x.core[i]!>y.core[i]!?1:-1;
  if(!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for(let i=0;i<Math.max(x.pre.length,y.pre.length);i++) {
    const l=x.pre[i],r=y.pre[i]; if(l===r)continue;if(l===undefined)return -1;if(r===undefined)return 1;
    const ln=/^\d+$/.test(l),rn=/^\d+$/.test(r);
    if(ln&&rn)return BigInt(l)>BigInt(r)?1:-1;if(ln!==rn)return ln?-1:1;return l>r?1:-1;
  }
  return 0;
}
export function validateManifest(value: unknown): ReleaseManifest {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid manifest');
  const v=value as Record<string,unknown>;
  const fields=['version','releasedAt','summary','securityNotes','migrationNotes','acceptanceNotes'];
  if(Object.keys(v).length!==fields.length||fields.some(k=>typeof v[k]!=='string'||!(v[k] as string).trim()||(v[k] as string).length>1500))throw new Error('Invalid fields');
  parseVersion(v.version as string);
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v.releasedAt as string)||!Number.isFinite(Date.parse(v.releasedAt as string))||new Date(v.releasedAt as string).toISOString().replace('.000Z','Z')!==v.releasedAt)throw new Error('Invalid date');
  return v as unknown as ReleaseManifest;
}
/** No timers, DB, credentials, caller URLs or mutations. Only explicitly opened admin UI checks. */
export function createReleaseChecker(fetcher: typeof fetch = fetch, now=Date.now, version=installedVersion) {
  let latest:ReleaseManifest|undefined, checkedAt:string|undefined, lastSuccessfulCheckAt:string|undefined;
  let nextCheck=0, failed=false, pending:Promise<void>|undefined;
  const snapshot=():ReleaseStatus=>({installedVersion:version,latest,checkedAt,lastSuccessfulCheckAt,stale:failed,state:failed||!latest?'offline':compareVersions(latest.version,version)>0?'available':compareVersions(latest.version,version)<0?'ahead':'current'});
  return async ():Promise<ReleaseStatus>=>{
    if(pending){await pending;return snapshot();}
    if(now()<nextCheck)return snapshot();
    pending=(async()=>{
      checkedAt=new Date(now()).toISOString();const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),4000);
      try {
        const response=await fetcher(MANIFEST,{signal:controller.signal,redirect:'error',headers:{Accept:'application/json'}});
        if(!response.ok||!response.body)throw new Error('Unavailable');
        const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
        try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw new Error('Too large');chunks.push(value);}} finally {await reader.cancel().catch(()=>{});}
        latest=validateManifest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        lastSuccessfulCheckAt=checkedAt;failed=false;nextCheck=now()+DAY;
      } catch {failed=true;nextCheck=now()+60*60*1000;}
      finally {clearTimeout(timer);}
    })();
    try {await pending;} finally {pending=undefined;}
    return snapshot();
  };
}
