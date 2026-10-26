import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSetup } from '../scripts/lib/template-setup.mjs';
import { parseArguments, formatReport, run } from '../scripts/check-setup.mjs';

const demo = () => ({
  PUBLIC_ORIGIN: 'https://store.example.invalid',
  DATABASE_URL: 'postgresql://synthetic:fixture-password@postgres.railway.internal:5432/starter',
  STARTER_DATASET: 'synthetic-retail-v1',
  STARTER_STORAGE: 'postgres',
  SQUARE_ENVIRONMENT: 'sandbox',
  SQUARE_SANDBOX_REQUESTS_ENABLED: 'false',
});
const sandbox = () => ({
  ...demo(), SQUARE_SANDBOX_REQUESTS_ENABLED: 'true',
  SQUARE_APPLICATION_ID: 'sandbox-sq0idb-fictional-app',
  SQUARE_LOCATION_ID: 'SYNTHETICLOCATION',
  SQUARE_SANDBOX_ACCESS_TOKEN: 'synthetic-not-a-real-access-token',
  SQUARE_SANDBOX_MERCHANT_ID: 'synthetic-merchant',
  SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'synthetic-not-a-real-signing-key',
});
const inspect = (values, profile = 'railway-demo', extra = {}) => inspectSetup(values, { profile, nodeVersion: '22.16.0', ...extra });
const failed = report => report.checks.filter(item => item.status === 'fail').map(item => item.code);
const hasFailure = (report, code) => assert.ok(failed(report).includes(code), `${code}: ${JSON.stringify(report)}`);
const execute = (args, values = {}) => { let output = ''; const code = run(args, values, text => { output += text; }); return { code, output }; };

test('credential-free local demo passes static checks without claiming commerce acceptance', () => {
  const report = inspect({}, 'local-demo');
  assert.equal(report.configurationValid, true);
  for (const flag of ['databaseConnectionVerified', 'squareConnectionVerified', 'paymentAcceptanceVerified', 'productionReady', 'activationChanged']) assert.equal(report[flag], false);
  assert.equal(report.validation, 'static-only');
});

test('profile validation rejects unknown targets and fresh local-demo checks', () => {
  assert.throws(() => inspect({}, 'production'));
  assert.throws(() => inspect({}, 'local-demo', { fresh: true }));
});

for (const version of ['22.12.0', '22.16.0', '22.23.3', '24.0.0']) {
  test(`accepts supported stable Node ${version}`, () => assert.equal(inspect({}, 'local-demo', { nodeVersion: version }).configurationValid, true));
}
for (const version of ['20.19.0', '22.11.0', '23.1.0', '25.0.0', '24.0.0-rc.1', 'malformed']) {
  test(`rejects unsupported Node version ${version}`, () => hasFailure(inspect({}, 'local-demo', { nodeVersion: version }), 'NODE_SUPPORTED'));
}

test('decimal port must be a bounded integer and cannot be an empty configured value', () => {
  for (const value of ['', '0', '-1', '65536', '1.5', '1e3', 'NaN', '8080\n', ' 8080']) hasFailure(inspect({ PORT: value }, 'local-demo'), 'PORT_VALID');
  for (const value of ['1', '3000', '8080', '65535']) assert.equal(inspect({ PORT: value }, 'local-demo').configurationValid, true);
});

test('demo cannot silently activate a provider or accept production mode', () => {
  hasFailure(inspect({ SQUARE_ENVIRONMENT: 'production' }, 'local-demo'), 'SQUARE_ENVIRONMENT_VALID');
  for (const value of ['true', 'TRUE', '1', 'yes', 'false ']) hasFailure(inspect({ SQUARE_SANDBOX_REQUESTS_ENABLED: value }, 'local-demo'), 'SQUARE_ACTIVATION_EXPLICIT');
  assert.equal(inspect({ SQUARE_SANDBOX_REQUESTS_ENABLED: 'false' }, 'local-demo').configurationValid, true);
});

test('local and hosted storage profiles cannot be confused', () => {
  hasFailure(inspect({ STARTER_STORAGE: 'postgres' }, 'local-demo'), 'STORAGE_PROFILE_VALID');
  hasFailure(inspect({ ...demo(), STARTER_STORAGE: 'memory' }), 'STORAGE_PROFILE_VALID');
  const values = demo(); delete values.STARTER_STORAGE;
  assert.equal(inspect(values).configurationValid, true);
});

test('local demo permits loopback HTTP but rejects remote HTTP and embedded URL credentials', () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://store.example.invalid']) assert.equal(inspect({ PUBLIC_ORIGIN: origin }, 'local-demo').configurationValid, true);
  for (const origin of ['http://store.example.invalid', 'https://secret:password@store.example.invalid', 'https://store.example.invalid/admin', 'https://store.example.invalid/?secret=1', 'https://store.example.invalid/#x']) hasFailure(inspect({ PUBLIC_ORIGIN: origin }, 'local-demo'), 'PUBLIC_ORIGIN_VALID');
});

test('Railway profile reports all missing required configuration rather than stopping at the first error', () => {
  const codes = failed(inspect({}));
  for (const code of ['PUBLIC_ORIGIN_VALID', 'SYNTHETIC_DATASET_REQUIRED', 'DATABASE_URL_VALID']) assert.ok(codes.includes(code));
});

test('complete isolated Railway demo configuration passes without connecting', () => {
  const report = inspect(demo());
  assert.deepEqual(failed(report), []);
  assert.equal(report.databaseConnectionVerified, false);
  assert.ok(report.checks.some(item => item.code === 'DATABASE_NOT_CONNECTED'));
});

test('Railway HTTPS origin rejects loopback HTTP, paths, fragments and unresolved references', () => {
  for (const value of ['http://localhost:3000', 'https://store.example.invalid/shop', 'https://store.example.invalid/#x', 'https://${{RAILWAY_PUBLIC_DOMAIN}}', 'replace-me']) hasFailure(inspect({ ...demo(), PUBLIC_ORIGIN: value }), 'PUBLIC_ORIGIN_VALID');
});

test('fresh database check requires explicit bootstrap acknowledgement; existing startup does not', () => {
  hasFailure(inspect(demo(), 'railway-demo', { fresh: true }), 'DATABASE_BOOTSTRAP_VALID');
  assert.equal(inspect({ ...demo(), STARTER_DB_BOOTSTRAP: 'empty-synthetic-only' }, 'railway-demo', { fresh: true }).configurationValid, true);
  hasFailure(inspect({ ...demo(), STARTER_DB_BOOTSTRAP: 'overwrite' }), 'DATABASE_BOOTSTRAP_VALID');
});

test('synthetic dataset safeguard cannot be replaced by an arbitrary merchant marker', () => {
  hasFailure(inspect({ ...demo(), STARTER_DATASET: 'real-merchant' }), 'SYNTHETIC_DATASET_REQUIRED');
});

test('database configuration rejects malformed, unrelated or unsafe target settings', () => {
  for (const value of ['not a url', '${{Postgres.DATABASE_URL}}', 'https://database.example.invalid/starter', 'postgresql://user:pass@postgres.railway.internal', 'postgresql://user:pass@postgres.railway.internal/urban-churn', 'postgresql://user:pass@postgres.railway.internal/starter#secret', 'postgresql://user:pass@postgres.railway.internal/starter?sslmode=disable', 'postgresql://user:pass@postgres.railway.internal/starter?sslmode=verify-full&sslmode=disable']) {
    hasFailure(inspect({ ...demo(), DATABASE_URL: value }), 'DATABASE_URL_VALID');
  }
});

test('loopback database host is not accepted for a two-service Railway template', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) hasFailure(inspect({ ...demo(), DATABASE_URL: `postgresql://synthetic:password@${host}/starter` }), 'DATABASE_HOST_REACHABLE_BY_DESIGN');
});

test('external databases require verified TLS and remain a warning for this private-network template', () => {
  for (const ending of ['', '?sslmode=require']) hasFailure(inspect({ ...demo(), DATABASE_URL: 'postgresql://synthetic:password@db.example.invalid/starter' + ending }), 'DATABASE_URL_VALID');
  const report = inspect({ ...demo(), DATABASE_URL: 'postgresql://synthetic:password@db.example.invalid/starter?sslmode=verify-full' });
  assert.equal(report.configurationValid, true);
  assert.ok(report.checks.some(item => item.code === 'PRIVATE_DATABASE_RECOMMENDED' && item.status === 'warning'));
});

test('private-host suffix lookalikes cannot bypass external TLS requirements', () => {
  hasFailure(inspect({ ...demo(), DATABASE_URL: 'postgresql://synthetic:password@postgres.railway.internal.example.invalid/starter' }), 'DATABASE_URL_VALID');
});

test('Square sandbox profile requires every configured identity and secret plus explicit activation', () => {
  const codes = failed(inspect(demo(), 'square-sandbox'));
  for (const code of ['SQUARE_ACTIVATION_EXPLICIT', 'SANDBOX_APPLICATION_VALID', 'SANDBOX_LOCATION_VALID', 'SANDBOX_TOKEN_FORMAT_VALID', 'SANDBOX_MERCHANT_VALID', 'SANDBOX_SIGNATURE_PRESENT']) assert.ok(codes.includes(code));
});

test('syntactically complete Square configuration is explicitly not payment acceptance or activation', () => {
  const values = sandbox(); const before = structuredClone(values);
  const report = inspect(Object.freeze(values), 'square-sandbox');
  assert.equal(report.configurationValid, true);
  assert.equal(report.squareConnectionVerified, false);
  assert.equal(report.paymentAcceptanceVerified, false);
  assert.equal(report.productionReady, false);
  assert.equal(report.activationChanged, false);
  assert.deepEqual(values, before);
  assert.ok(report.checks.some(item => item.code === 'SQUARE_ACCEPTANCE_NOT_RUN'));
});

test('sandbox identity shape checks reject production IDs and invalid lengths or characters', () => {
  const cases = [
    ['SQUARE_APPLICATION_ID', 'sq0idp-production', 'SANDBOX_APPLICATION_VALID'],
    ['SQUARE_APPLICATION_ID', 'sandbox-sq0idb-', 'SANDBOX_APPLICATION_VALID'],
    ['SQUARE_LOCATION_ID', 'bad location', 'SANDBOX_LOCATION_VALID'],
    ['SQUARE_LOCATION_ID', 'L'.repeat(65), 'SANDBOX_LOCATION_VALID'],
    ['SQUARE_SANDBOX_MERCHANT_ID', 'bad/merchant', 'SANDBOX_MERCHANT_VALID'],
    ['SQUARE_SANDBOX_MERCHANT_ID', 'M'.repeat(193), 'SANDBOX_MERCHANT_VALID'],
  ];
  for (const [name, value, code] of cases) hasFailure(inspect({ ...sandbox(), [name]: value }, 'square-sandbox'), code);
});

test('blank, placeholder and whitespace-bearing credentials fail without disclosure', () => {
  const cases = [
    ['SQUARE_SANDBOX_ACCESS_TOKEN', 'short', 'SANDBOX_TOKEN_FORMAT_VALID'],
    ['SQUARE_SANDBOX_ACCESS_TOKEN', 'very-long-secret with-space', 'SANDBOX_TOKEN_FORMAT_VALID'],
    ['SQUARE_SANDBOX_ACCESS_TOKEN', 'YOUR_SANDBOX_TOKEN', 'SANDBOX_TOKEN_FORMAT_VALID'],
    ['SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY', '', 'SANDBOX_SIGNATURE_PRESENT'],
    ['SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY', 'replace-me', 'SANDBOX_SIGNATURE_PRESENT'],
    ['SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY', ' \n ', 'SANDBOX_SIGNATURE_PRESENT'],
  ];
  for (const [name, value, code] of cases) hasFailure(inspect({ ...sandbox(), [name]: value }, 'square-sandbox'), code);
});

test('staged credentials in demo do not create a false connected state', () => {
  const values = { ...sandbox(), SQUARE_SANDBOX_REQUESTS_ENABLED: 'false' };
  const report = inspect(values);
  assert.equal(report.configurationValid, true);
  assert.equal(report.squareConnectionVerified, false);
  assert.ok(report.checks.some(item => item.code === 'STAGED_CREDENTIALS_DO_NOT_ENABLE_PAYMENTS'));
});

test('browser-prefixed credentials are refused without echoing dynamic names or values', () => {
  for (const prefix of ['VITE_', 'NEXT_PUBLIC_', 'PUBLIC_']) {
    const key = prefix + 'SQUARE_ACCESS_TOKEN';
    const report = inspect({ ...sandbox(), [key]: 'VERY_PRIVATE_CANARY' }, 'square-sandbox');
    hasFailure(report, 'NO_BROWSER_SECRETS');
    const text = JSON.stringify(report) + formatReport(report);
    assert.ok(!text.includes('VERY_PRIVATE_CANARY'));
    assert.ok(!text.includes(key));
  }
});

test('all supplied values, including database credentials and malicious URL content, stay out of text/JSON reports', () => {
  const values = {
    ...sandbox(),
    DATABASE_URL: 'postgresql://PRIVATE_USER:PRIVATE_PASSWORD@private-host.example.invalid/private-database?sslmode=verify-full',
    PUBLIC_ORIGIN: 'https://PRIVATE_CANARY.invalid/?do-not-log=PRIVATE_QUERY',
    SQUARE_SANDBOX_ACCESS_TOKEN: 'PRIVATE_TOKEN_CANNOT_LEAK',
    SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY: 'PRIVATE_SIGNATURE_CANNOT_LEAK',
    UNRELATED_PRIVATE_VALUE: 'PRIVATE_UNRELATED_CANNOT_LEAK',
  };
  const text = JSON.stringify(inspect(values, 'square-sandbox')) + formatReport(inspect(values, 'square-sandbox'));
  for (const value of ['PRIVATE_USER', 'PRIVATE_PASSWORD', 'private-host.example.invalid', 'PRIVATE_CANARY', 'PRIVATE_QUERY', 'PRIVATE_TOKEN_CANNOT_LEAK', 'PRIVATE_SIGNATURE_CANNOT_LEAK', 'PRIVATE_UNRELATED_CANNOT_LEAK']) assert.ok(!text.includes(value), value);
});

test('checking configuration never calls global fetch or changes input values', () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Network calls forbidden'); };
  try {
    const values = Object.freeze(sandbox());
    assert.equal(inspect(values, 'square-sandbox').configurationValid, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('CLI supports explicit profiles, fresh acknowledgement checks, JSON and pnpm separator', () => {
  assert.deepEqual(parseArguments(['--', '--profile', 'square-sandbox', '--fresh', '--json']), { profile: 'square-sandbox', fresh: true, json: true, help: false });
});

test('CLI rejects unknown, duplicate, incomplete and secret-bearing arguments without reflecting them', () => {
  for (const args of [['--unknown'], ['--profile'], ['--profile', 'production'], ['--json', '--json'], ['--fresh'], ['--token=DO_NOT_PRINT_ME'], ['--profile', 'DO_NOT_PRINT_ME', '--json']]) {
    const result = execute(args);
    assert.equal(result.code, 2);
    assert.ok(!result.output.includes('DO_NOT_PRINT_ME'));
  }
});

test('CLI returns zero for static pass, one for configuration failure and two for invalid use', () => {
  assert.equal(execute(['--json']).code, 0);
  const bad = execute(['--profile', 'square-sandbox', '--json']);
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.output).configurationValid, false);
  assert.equal(execute(['--json', '--nonsense']).code, 2);
});

test('CLI help does not inspect configuration', () => {
  const env = new Proxy({}, { get: () => { throw new Error('DO_NOT_INSPECT'); } });
  const result = execute(['--help'], env);
  assert.equal(result.code, 0);
  assert.match(result.output, /never loads .env files/);
});

test('unexpected exceptions are sanitized rather than printing credential-bearing exception text', () => {
  const env = new Proxy({}, { get: () => { throw new Error('PRIVATE_EXCEPTION_TOKEN'); } });
  const result = execute(['--json'], env);
  assert.equal(result.code, 2);
  assert.equal(JSON.parse(result.output).error, 'SETUP_CHECK_FAILED');
  assert.ok(!result.output.includes('PRIVATE_EXCEPTION_TOKEN'));
});

test('actual command exits correctly and does not load .env files from its working directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'square-setup-check-'));
  try {
    writeFileSync(join(dir, '.env'), 'SQUARE_ENVIRONMENT=production\nSQUARE_SANDBOX_ACCESS_TOKEN=PRIVATE_DOTENV_CANARY\n');
    const cli = fileURLToPath(new URL('../scripts/check-setup.mjs', import.meta.url));
    const local = spawnSync(process.execPath, [cli, '--json'], { cwd: dir, env: {}, encoding: 'utf8', timeout: 5000 });
    assert.equal(local.status, 0); assert.equal(local.stderr, '');
    assert.equal(JSON.parse(local.stdout).configurationValid, true);
    assert.ok(!local.stdout.includes('PRIVATE_DOTENV_CANARY'));
    const hosted = spawnSync(process.execPath, [cli, '--profile', 'railway-demo', '--fresh', '--json'], { cwd: dir, env: {}, encoding: 'utf8', timeout: 5000 });
    assert.equal(hosted.status, 1);
    assert.equal(JSON.parse(hosted.stdout).configurationValid, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('package retains the existing application tests/build and adds a zero-dependency setup check', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['setup:check'], 'node scripts/check-setup.mjs');
  assert.equal(pkg.scripts['test:setup'], 'node --test tests/template-setup.test.mjs tests/merchant-production-setup.test.mjs tests/buyer-railway-plan.test.mjs tests/release-metadata.test.mjs');
  assert.equal(pkg.scripts.check, 'pnpm test:setup && pnpm typecheck && pnpm test && pnpm build');
  assert.match(pkg.scripts.test, /tests\/merchant-settings.test.ts/);
  assert.equal(pkg.packageManager, 'pnpm@12.14.0');
});


const merchantSandbox = () => ({
  ...sandbox(), DATABASE_URL: undefined, STARTER_DATASET: 'merchant-catalog-v1',
  MERCHANT_DATABASE_URL: 'postgresql://fixture:fixture-password@postgres.railway.internal:5432/merchant',
  SQUARE_MERCHANT_COMMERCE_ENABLED: 'true', MERCHANT_ADMIN_SESSION_KEY: 'A'.repeat(43),
  MERCHANT_NAME: 'Fixture Supply', MERCHANT_PICKUP_LABEL: 'Fixture counter',
  MERCHANT_PICKUP_INSTRUCTIONS: 'Sandbox test pickup only. No real orders.',
});
test('merchant sandbox profile validates separate installation without running setup or accepting payments', () => {
  const values=Object.freeze(merchantSandbox());
  const report=inspect(values,'merchant-sandbox',{fresh:true});
  assert.deepEqual(failed(report),[]);
  assert.equal(report.startCommand,'pnpm start:merchant');
  assert.equal(report.productionReady,false);
  assert.equal(report.activationChanged,false);
  assert.equal(report.databaseConnectionVerified,false);
  assert.equal(report.paymentAcceptanceVerified,false);
  assert.ok(report.checks.some(c=>c.code==='MERCHANT_INSTALLATION_NOT_RUN'));
  assert.ok(report.checks.some(c=>c.code==='SANDBOX_SIGNATURE_PRESENT'&&c.message.includes('/api/commerce/webhooks')));
  assert.deepEqual(parseArguments(['--profile','merchant-sandbox','--fresh']),{profile:'merchant-sandbox',fresh:true,json:false,help:false});
});
test('merchant profile cannot reuse synthetic identity, database or startup bootstrap', () => {
  hasFailure(inspect({...merchantSandbox(),STARTER_DATASET:'synthetic-retail-v1'},'merchant-sandbox'),'MERCHANT_DATASET_REQUIRED');
  hasFailure(inspect({...merchantSandbox(),DATABASE_URL:merchantSandbox().MERCHANT_DATABASE_URL},'merchant-sandbox'),'MERCHANT_DATABASE_DISTINCT');
  hasFailure(inspect({...merchantSandbox(),MERCHANT_DATABASE_URL:undefined},'merchant-sandbox'),'DATABASE_URL_VALID');
  hasFailure(inspect({...merchantSandbox(),MERCHANT_DATABASE_URL:'postgresql://fixture:pass@postgres.railway.internal/synthetic'},'merchant-sandbox'),'DATABASE_URL_VALID');
  hasFailure(inspect({...merchantSandbox(),STARTER_DB_BOOTSTRAP:'empty-synthetic-only'},'merchant-sandbox'),'DATABASE_BOOTSTRAP_VALID');
  hasFailure(inspect({...merchantSandbox(),SQUARE_MERCHANT_COMMERCE_ENABLED:'false'},'merchant-sandbox'),'MERCHANT_COMMERCE_EXPLICIT');
  hasFailure(inspect({...merchantSandbox(),SQUARE_SANDBOX_REQUESTS_ENABLED:'false'},'merchant-sandbox'),'SQUARE_ACTIVATION_EXPLICIT');
  hasFailure(inspect({...merchantSandbox(),SQUARE_ENVIRONMENT:'production'},'merchant-sandbox'),'SQUARE_ENVIRONMENT_VALID');
  hasFailure(inspect(merchantSandbox(),'square-sandbox'),'SYNTHETIC_DATASET_REQUIRED');
});
test('merchant staff key requires canonical 32-byte base64url and remains server-only', () => {
  for(const key of ['', 'A'.repeat(42),'A'.repeat(44),'A'.repeat(42)+'B','+'.repeat(43)])hasFailure(inspect({...merchantSandbox(),MERCHANT_ADMIN_SESSION_KEY:key},'merchant-sandbox'),'MERCHANT_SESSION_KEY_VALID');
  const key=Buffer.alloc(32,7).toString('base64url');
  const report=inspect({...merchantSandbox(),MERCHANT_ADMIN_SESSION_KEY:key,PUBLIC_MERCHANT_ADMIN_SESSION_KEY:key},'merchant-sandbox');
  hasFailure(report,'NO_BROWSER_SECRETS');
  assert.ok(!JSON.stringify(report).includes(key));
  assert.ok(!formatReport(report).includes(key));
});
test('merchant presentation is required, bounded, placeholder-free and not echoed', () => {
  for(const [name,max] of [['MERCHANT_NAME',100],['MERCHANT_PICKUP_LABEL',100],['MERCHANT_PICKUP_INSTRUCTIONS',500]]) {
    for(const value of ['', ' ', 'replace-me', 'x'.repeat(max+1), 'private\ncanary'])hasFailure(inspect({...merchantSandbox(),[name]:value},'merchant-sandbox'),name+'_VALID');
    assert.equal(inspect({...merchantSandbox(),[name]:'x'.repeat(max)},'merchant-sandbox').configurationValid,true);
  }
  const report=inspect({...merchantSandbox(),MERCHANT_PICKUP_INSTRUCTIONS:'PRIVATE_CANARY_PICKUP'},'merchant-sandbox');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_CANARY_PICKUP'));
});
test('merchant checker makes no fetch call or input mutation and CLI accepts valid profile', () => {
  const previous=globalThis.fetch;globalThis.fetch=()=>{throw new Error('No provider calls allowed');};
  try {
    const values=merchantSandbox(),snapshot=structuredClone(values);
    const result=execute(['--profile','merchant-sandbox','--fresh','--json'],Object.freeze(values));
    assert.equal(result.code,0);assert.equal(JSON.parse(result.output).profile,'merchant-sandbox');
    assert.deepEqual(values,snapshot);
  }finally{globalThis.fetch=previous;}
});


test('merchant webhook profile only permits exact fresh or preserved sandbox callback path',()=>{
 for(const path of ['/api/commerce/webhooks','/api/sandbox/webhooks'])assert.equal(inspect({...merchantSandbox(),SQUARE_MERCHANT_WEBHOOK_PATH:path},'merchant-sandbox').configurationValid,true);
 for(const path of ['/api/other','https://example.invalid/webhook','/api/sandbox/webhooks?x=1'])hasFailure(inspect({...merchantSandbox(),SQUARE_MERCHANT_WEBHOOK_PATH:path},'merchant-sandbox'),'MERCHANT_WEBHOOK_PATH_VALID');
});
