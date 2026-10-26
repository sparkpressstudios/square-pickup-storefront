import assert from 'node:assert/strict';
import test from 'node:test';
import { SquareInventoryPreviewError, previewSquareSandboxInventory } from '../server/src/square-inventory-readonly';
const config = { environment: 'sandbox' as const, token: 'synthetic-access-token-only', locationId: 'LOC123' };
const row = (id: string, quantity: string, locationId = config.locationId, time = '2026-10-23T12:00:00Z') => ({
  catalog_object_id: id, catalog_object_type: 'ITEM_VARIATION', location_id: locationId,
  state: 'IN_STOCK', quantity, calculated_at: time,
});
const response = (value: unknown, status=200) => new Response(JSON.stringify(value), { status });

test('Square stock evidence is exact location-scoped and never enables a merchant product', async () => {
  let requests=0;
  const result=await previewSquareSandboxInventory(config, ['VAR_B','VAR_A','VAR_C'], async (url, init) => {
    requests++;
    assert.equal(url,'https://connect.squareupsandbox.com/v2/inventory/counts/batch-retrieve');
    assert.equal(init?.method,'POST'); assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body));
    assert.deepEqual(body.catalog_object_ids,['VAR_A','VAR_B','VAR_C']);
    assert.deepEqual(body.location_ids,['LOC123']); assert.deepEqual(body.states,['IN_STOCK']);
    assert.equal(body.limit,100);
    return response({ counts: [row('VAR_A','22'), row('VAR_C','0')] });
  });
  assert.equal(requests,1);assert.equal(result.mode,'sandbox-read-only');assert.equal(result.inventoryOwner,'square');
  assert.equal(result.verified,2);assert.equal(result.held,1);assert.equal(result.enabledProducts,0);
  assert.deepEqual(result.evidence.map(x=>({id:x.squareVariationId,quantity:x.quantity,reason:x.reason})),[
    {id:'VAR_A',quantity:22,reason:null},
    {id:'VAR_B',quantity:null,reason:'NO_TRACKED_COUNT'},
    {id:'VAR_C',quantity:0,reason:null},
  ]);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-access-token-only/);
});

test('multi-page evidence is bounded and exact, with no duplicate counts accepted', async () => {
  const requests: string[]=[];
  const fetcher: typeof fetch=async (_url, init) => {
    const request=JSON.parse(String(init?.body));
    requests.push(request.cursor ?? 'first');
    return response(request.cursor === 'SECOND' ? { counts:[row('VAR_B','15')] }
      : { counts:[row('VAR_A','8')],cursor:'SECOND' });
  };
  const output=await previewSquareSandboxInventory(config,['VAR_B','VAR_A'],fetcher);
  assert.deepEqual(requests,['first','SECOND']);
  assert.deepEqual(output.evidence.map(v=>v.quantity),[8,15]);
  assert.equal(output.pages,2);
  await assert.rejects(previewSquareSandboxInventory(config,['VAR_A'],async()=>response({counts:[row('VAR_A','1'),row('VAR_A','2')]})),e=>e instanceof SquareInventoryPreviewError&&e.code==='AMBIGUOUS_COUNTS');
  await assert.rejects(previewSquareSandboxInventory(config,['VAR_A'],async()=>response({counts:[],cursor:'SAME'})),e=>e instanceof SquareInventoryPreviewError&&e.code==='PAGINATION_LIMIT');
});

test('fractional, negative, untracked and missing timestamp quantities hold instead of enabling stock', async () => {
  for(const [qty,stamp,reason] of [
    ['2.5','2026-10-23T12:00:00Z','UNSUPPORTED_QUANTITY'],
    ['-2','2026-10-23T12:00:00Z','UNSUPPORTED_QUANTITY'],
    ['2147483648','2026-10-23T12:00:00Z','UNSUPPORTED_QUANTITY'],
    ['15',undefined,'NO_TIMESTAMP'],
  ] as const) {
    const count = row('VAR_X',qty);
    const record = stamp === undefined ? { ...count, calculated_at: undefined } : { ...count, calculated_at: stamp };
    const result=await previewSquareSandboxInventory(config,['VAR_X'],async()=>response({
      counts:[record],
    }));
    assert.equal(result.verified,0);assert.equal(result.held,1);
    assert.equal(result.evidence[0]!.reason,reason);
    assert.equal(result.evidence[0]!.quantity,null);
    assert.equal(result.enabledProducts,0);
  }
});

test('wrong location, unrequested variation, or inventory state causes complete refusal', async () => {
  for (const r of [row('VAR_X','9','OTHER'),row('UNRELATED','9'),{...row('VAR_X','9'),state:'RESERVED_FOR_SALE'}]) {
    await assert.rejects(previewSquareSandboxInventory(config,['VAR_X'],async()=>response({counts:[r]})),
      e=>e instanceof SquareInventoryPreviewError&&e.code==='INVALID_RESPONSE');
  }
});
test('non-sandbox configs, repeated and oversize identifier batches fail before provider fetch', async () => {
  let calls=0;const fetcher:typeof fetch=async()=>{calls++;return response({counts:[]});};
  for (const [cfg, ids] of [
    [{...config,environment:'production'},['VAR_X']],
    [config,['VAR_X','VAR_X']],
    [config,[]],
    [config,Array.from({length:101},(_,i)=>'V'+i)],
    [config,['VAR with spaces']],
  ] as const) {
    await assert.rejects(previewSquareSandboxInventory(cfg as unknown as typeof config,ids,fetcher),
      e=>e instanceof SquareInventoryPreviewError&&e.code==='INVALID_REQUEST');
  }
  assert.equal(calls,0);
});
test('provider failures never leak tokens or untrusted details',async()=>{
  await assert.rejects(previewSquareSandboxInventory(config,['VAR_X'],async()=>response({
    errors:[{ detail: config.token }],
  },403)),e=>e instanceof SquareInventoryPreviewError&&e.code==='AUTHORIZATION'&&!e.message.includes(config.token));
  await assert.rejects(previewSquareSandboxInventory(config,['VAR_X'],async()=>{throw new Error(config.token);}),
    e=>e instanceof SquareInventoryPreviewError&&e.code==='REMOTE_ERROR'&&!e.message.includes(config.token));
});
