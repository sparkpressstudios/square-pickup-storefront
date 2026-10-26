import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePreorderSchedule, previewPreorderSlots, preorderScheduleFromSettings } from '../server/src/square-preorder-availability';
import { createSquareServices } from '../server/src/square-services';
import { SquarePreorderError } from '../server/src/square-preorders';

const open={open:'09:00',close:'17:00'};
const schedule={
  businessTimezone:'America/New_York',
  slotMinutes:30,
  capacityPerSlot:6,
  minLeadMinutes:120,
  maxDaysAhead:30,
  hours:{sun:null,mon:open,tue:open,wed:open,thu:open,fri:open,sat:null},
  closedDates:['2026-10-27'],
};
const values={
  STARTER_DATASET:'merchant-catalog-v1',SQUARE_ENVIRONMENT:'sandbox',
  SQUARE_SANDBOX_REQUESTS_ENABLED:'true',SQUARE_APPLICATION_ID:'sandbox-sq0idb-test-app',
  SQUARE_LOCATION_ID:'LOCATION123',SQUARE_SANDBOX_MERCHANT_ID:'MERCHANT123',
  SQUARE_SANDBOX_ACCESS_TOKEN:'synthetic-no-real-token',
  SQUARE_PREORDERS_PREVIEW_ENABLED:'true',
  SQUARE_PREORDER_SCHEDULE_JSON:JSON.stringify(schedule),
};
test('merchants explicitly choose business timezone and weekday hours; slots never claim live capacity',()=>{
  const p=parsePreorderSchedule(schedule);
  const now=Date.parse('2026-10-25T12:00:00Z');
  const slots=previewPreorderSlots(p,'2026-10-26',now);
  assert.equal(slots.mode,'scheduled-pickup-slots-preview');
  assert.equal(slots.businessTimezone,'America/New_York');
  assert.equal(slots.slots.length,16);
  assert.equal(slots.slots[0]?.localTime,'09:00');
  assert.equal(slots.slots[0]?.pickupAt,'2026-10-26T13:00:00.000Z');
  assert.equal(slots.slots.at(-1)?.localTime,'16:30');
  assert.equal(slots.capacityVerified,false);
  assert.equal(slots.businessHoursVerified,false);
  assert.equal(slots.checkoutAuthorized,false);
  for(const slot of slots.slots){
    assert.equal(slot.configuredCapacity,6);
    assert.equal(slot.remainingCapacity,null);
    assert.equal(slot.reservedQuantity,null);
    assert.equal(slot.checkoutAvailable,false);
    assert.equal(slot.capacityReservationRequired,true);
  }
  assert.equal(previewPreorderSlots(p,'2026-10-27',now).slots.length,0);
  assert.equal(previewPreorderSlots(p,'2026-10-31',now).slots.length,0);
});
test('lead-time limits, forward horizon and strict calendar dates fail closed',()=>{
  const policy=parsePreorderSchedule(schedule);
  const now=Date.parse('2026-10-26T14:00:00Z'); // 10 am local; lead means earliest noon
  const slots=previewPreorderSlots(policy,'2026-10-26',now);
  assert.equal(slots.slots[0]?.localTime,'12:00');
  for(const wrong of ['2026-02-30','2026-13-05','10/27/2026','2026-10-26?x=1','2026-10-26T09:00'])
    assert.throws(()=>previewPreorderSlots(policy,wrong,now),(e:unknown)=>e instanceof SquarePreorderError);
  const service=createSquareServices(values,async()=>{throw Error('should not fetch');});
  assert.equal(service.availability.preorderSlotsConfigured,true);
  assert.equal(service.preorderSlots('2026-10-26',now).slots[0]?.localTime,'12:00');
  assert.throws(()=>service.preorder({pickupAt:'2026-10-26T15:30:00Z',windowMinutes:30},now),
    (e:unknown)=>e instanceof SquarePreorderError&&e.code==='INVALID_PICKUP_TIME');
  assert.equal(service.preorder({pickupAt:'2026-10-26T16:00:00Z',windowMinutes:30},now).pickupAt,
    '2026-10-26T16:00:00.000Z');
  assert.throws(()=>service.preorder({pickupAt:'2026-10-27T16:00:00Z',windowMinutes:30},now),
    (e:unknown)=>e instanceof SquarePreorderError&&e.code==='INVALID_PICKUP_TIME');
});
test('DST fall-back repeated wall times are omitted rather than silently choosing one hour',()=>{
  const policy=parsePreorderSchedule({
    ...schedule,slotMinutes:15,closedDates:[],minLeadMinutes:120,
    hours:{...schedule.hours,sun:{open:'00:00',close:'04:00'}},
  });
  const slots=previewPreorderSlots(policy,'2026-11-01',Date.parse('2026-10-31T09:00:00Z'));
  assert.ok(slots.slots.some(slot=>slot.localTime==='00:30'));
  assert.ok(slots.slots.some(slot=>slot.localTime==='02:30'));
  assert.ok(!slots.slots.some(slot=>slot.localTime.startsWith('01:')));
  assert.equal(new Set(slots.slots.map(slot=>slot.localTime)).size,slots.slots.length);
});
test('DST spring-forward missing hours are never invented',()=>{
  const policy=parsePreorderSchedule({
    ...schedule,slotMinutes:30,closedDates:[],
    hours:{...schedule.hours,sun:{open:'00:00',close:'04:00'}},
  });
  const slots=previewPreorderSlots(policy,'2027-03-14',Date.parse('2027-03-13T09:00:00Z'));
  assert.ok(slots.slots.some(slot=>slot.localTime==='01:30'));
  assert.ok(slots.slots.some(slot=>slot.localTime==='03:00'));
  assert.ok(!slots.slots.some(slot=>slot.localTime.startsWith('02:')));
});
test('invalid timezone, overnight hours, duplicate closures and misleading capacity fail before use',()=>{
  const wrong:any[]=[
    {...schedule,businessTimezone:'Wrong/Imaginary'},
    {...schedule,businessTimezone:'UTC'},
    {...schedule,slotMinutes:17},
    {...schedule,capacityPerSlot:0},
    {...schedule,capacityPerSlot:1.25},
    {...schedule,minLeadMinutes:15},
    {...schedule,maxDaysAhead:40},
    {...schedule,closedDates:['2026-10-27','2026-10-27']},
    {...schedule,closedDates:['2026-02-29']},
    {...schedule,hours:{...schedule.hours,mon:{open:'17:00',close:'09:00'}}},
    {...schedule,hours:{...schedule.hours,mon:{open:'09:00',close:'09:00'}}},
    {...schedule,other:1},
  ];
  for(const candidate of wrong)
    assert.throws(()=>parsePreorderSchedule(candidate),(e:unknown)=>e instanceof SquarePreorderError&&e.code==='INVALID_WINDOW');
  assert.equal(preorderScheduleFromSettings({
    ...values,SQUARE_PREORDERS_PREVIEW_ENABLED:'false',
  }),null);
  assert.throws(()=>preorderScheduleFromSettings({...values,SQUARE_PREORDER_SCHEDULE_JSON:'{bad'}),
    (e:unknown)=>e instanceof SquarePreorderError);
  assert.throws(()=>createSquareServices({...values,SQUARE_PREORDER_SCHEDULE_JSON:'{bad'},
    async()=>{throw Error('no calls');}),
    (e:unknown)=>e instanceof SquarePreorderError);
});
