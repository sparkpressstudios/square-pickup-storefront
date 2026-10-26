import assert from 'node:assert/strict';
import test from 'node:test';
import { attachSandboxCard, type SandboxCard, type VerificationDetails } from '../client/src/square-tokenization';
import { squareSandboxScript } from '../shared/square-sandbox';

const config = { environment: 'sandbox', applicationId: 'sandbox-sq0idb-unit-application', locationId: 'TESTLOCATION01' } as const;
function fixture() {
  const loads: string[] = []; const attachments: string[] = []; const details: VerificationDetails[] = []; let destroys = 0;
  const card: SandboxCard = { async attach(target) { attachments.push(target); }, async destroy() { destroys += 1; }, async tokenize(value) { details.push(value); return { status: 'OK', token: 'unit-card-token' }; } };
  const dependencies = { isSecureContext: true, async loadSdk(url: typeof squareSandboxScript) { loads.push(url); return { payments(applicationId: string, locationId: string) { assert.equal(applicationId, config.applicationId); assert.equal(locationId, config.locationId); return { async card() { return card; } }; } }; } };
  return { loads, attachments, details, card, dependencies, destroys: () => destroys };
}

test('tokenization fails before SDK load for production/incomplete config or insecure context', async () => {
  const mock = fixture();
  await assert.rejects(attachSandboxCard({ ...config, environment: 'production' } as unknown as typeof config, '#card', mock.dependencies));
  await assert.rejects(attachSandboxCard({ ...config, locationId: undefined } as unknown as typeof config, '#card', mock.dependencies));
  await assert.rejects(attachSandboxCard(config, '#card', { ...mock.dependencies, isSecureContext: false }));
  assert.equal(mock.loads.length, 0);
});

test('prepared lifecycle selects the fixed sandbox script and matching app/location, then attaches', async () => {
  const mock = fixture(); const controller = await attachSandboxCard(config, '#card', mock.dependencies);
  assert.deepEqual(mock.loads, [squareSandboxScript]); assert.deepEqual(mock.attachments, ['#card']);
  await controller.destroy(); await controller.destroy(); assert.equal(mock.destroys(), 1);
});

test('tokenization passes exact USD amount and customer-initiated verification details without storage', async () => {
  const mock = fixture(); const controller = await attachSandboxCard(config, '#card', mock.dependencies);
  assert.equal(await controller.tokenize(2400, { countryCode: 'US' }), 'unit-card-token');
  assert.deepEqual(mock.details, [{ amount: '24.00', currencyCode: 'USD', intent: 'CHARGE', customerInitiated: true, sellerKeyedIn: false, billingContact: { countryCode: 'US' } }]);
  await controller.destroy();
});

test('duplicate in-flight tokenization shares one call, but changed amount is rejected', async () => {
  const mock = fixture(); let release!: (value: { status: string; token: string }) => void; let calls = 0;
  mock.card.tokenize = async () => { calls += 1; return new Promise((resolve) => { release = resolve; }); };
  const controller = await attachSandboxCard(config, '#card', mock.dependencies);
  const a = controller.tokenize(2400, { countryCode: 'US' }); const b = controller.tokenize(2400, { countryCode: 'US' });
  await assert.rejects(controller.tokenize(100, { countryCode: 'US' }), /in progress/);
  release({ status: 'OK', token: 'unit-card-token' }); assert.deepEqual(await Promise.all([a,b]), ['unit-card-token','unit-card-token']); assert.equal(calls, 1);
  await controller.destroy();
});

test('tokenization failures and cancellation return sanitized errors without a payment call', async () => {
  for (const result of [{ status: 'CANCELED' }, { status: 'INVALID' }, { status: 'OK', token: '' }]) {
    const mock = fixture(); mock.card.tokenize = async () => result;
    const controller = await attachSandboxCard(config, '#card', mock.dependencies);
    await assert.rejects(controller.tokenize(2400, { countryCode: 'US' }), /No payment request was sent/); await controller.destroy();
  }
});

test('invalid amounts and raw-card/unsupported contact fields never reach card tokenization', async () => {
  const mock = fixture(); const controller = await attachSandboxCard(config, '#card', mock.dependencies);
  for (const amount of [0,-1,0.5,NaN,Infinity,2_147_483_648]) await assert.rejects(controller.tokenize(amount, { countryCode: 'US' }));
  await assert.rejects(controller.tokenize(2400, { countryCode: 'US', cardNumber: 'not-accepted' } as unknown as { countryCode: 'US' }));
  assert.equal(mock.details.length, 0); await controller.destroy();
});

test('attach failure cleans up, and destroying during tokenization prevents returning a late token', async () => {
  const failed = fixture(); failed.card.attach = async () => { throw new Error('SDK internal detail'); };
  await assert.rejects(attachSandboxCard(config, '#card', failed.dependencies), /could not be attached/); assert.equal(failed.destroys(), 1);
  const mock = fixture(); let release!: (value: { status: string; token: string }) => void;
  mock.card.tokenize = async () => new Promise((resolve) => { release = resolve; });
  const controller = await attachSandboxCard(config, '#card', mock.dependencies); const token = controller.tokenize(2400, { countryCode: 'US' });
  await controller.destroy(); release({ status: 'OK', token: 'late-token' }); await assert.rejects(token, /did not complete/);
  await assert.rejects(controller.tokenize(2400, { countryCode: 'US' }));
});
