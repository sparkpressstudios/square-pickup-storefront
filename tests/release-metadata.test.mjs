import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('public release candidate metadata is consistent and preserves release checks',()=>{
 const pkg=JSON.parse(read('package.json'));
 assert.equal(pkg.version,'0.1.0-rc.2');assert.equal(pkg.private,true);
 assert.equal(pkg.scripts.check,'pnpm test:setup && pnpm typecheck && pnpm test && pnpm build');
 for(const path of ['README.md','CHANGELOG.md','SECURITY.md'])assert.ok(read(path).includes(pkg.version),path);
 assert.match(read('CHANGELOG.md'),/Sanitized.*distribution/i);
 assert.equal(pkg.license,'MIT');
 assert.match(read('LICENSE'),/Copyright \(c\) 2026 SparkPress Studios/);
 assert.match(read('LICENSE'),/and\/or sell/);
 assert.doesNotMatch(read('LICENSE'),/AWAITING|LLC|Inc\./);
});
test('security and upgrade policy do not promise forced access or reversal of external effects',()=>{
 const security=read('SECURITY.md'),upgrades=read('docs/UPGRADES.md');
 assert.match(security,/adamb@sparkpressstudios\.com/);
 assert.match(security,/No production-support SLA/);
 assert.match(security,/no fleet controller/);
 assert.match(upgrades,/email/i);assert.match(upgrades,/Square/);assert.match(upgrades,/checksum/);
});
