import { SquarePreorderError } from './square-preorders';

type Weekday='mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun';
const weekdays:readonly Weekday[]=['sun','mon','tue','wed','thu','fri','sat'];
interface Window { readonly open:string;readonly close:string }
export interface PreorderSchedule {
  readonly businessTimezone:string;
  readonly slotMinutes:15|30|60;
  readonly capacityPerSlot:number;
  readonly minLeadMinutes:number;
  readonly maxDaysAhead:number;
  readonly hours:Readonly<Record<Weekday,Window|null>>;
  readonly closedDates:readonly string[];
}
export interface PreorderSlot {
  readonly pickupAt:string;
  readonly localDate:string;
  readonly localTime:string;
  readonly businessTimezone:string;
  readonly configuredCapacity:number;
  readonly remainingCapacity:null;
  readonly reservedQuantity:null;
  readonly checkoutAvailable:false;
  readonly capacityReservationRequired:true;
}
export interface PreorderSlotPreview {
  readonly mode:'scheduled-pickup-slots-preview';
  readonly date:string;
  readonly businessTimezone:string;
  readonly slots:readonly PreorderSlot[];
  readonly capacityVerified:false;
  readonly businessHoursVerified:false;
  readonly checkoutAuthorized:false;
}
const isObject=(value:unknown):value is Record<string,unknown> =>
  !!value && typeof value==='object' && !Array.isArray(value) &&
  Object.getPrototypeOf(value)===Object.prototype;
function strictDate(value:unknown):value is string {
  if(typeof value!=='string' || !/^\d{4}-\d\d-\d\d$/.test(value))return false;
  const d=new Date(value+'T00:00:00.000Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10)===value;
}
function parseTime(value:unknown):number|null {
  if(typeof value!=='string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value))return null;
  const [hour,minute]=value.split(':').map(Number);
  return hour!*60+minute!;
}
function validTimezone(zone:unknown):zone is string {
  if(typeof zone!=='string' || zone.length>80 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/.test(zone))
    return false;
  try{new Intl.DateTimeFormat('en-US',{timeZone:zone});return true;}
  catch{return false;}
}
function validKeys(value:Record<string,unknown>,names:readonly string[]):boolean {
  const keys=Object.keys(value);
  return keys.length===names.length && keys.every(key=>names.includes(key));
}
/** Explicit validated merchant time policy; malformed/partial schedules are refused. */
export function parsePreorderSchedule(input:unknown):PreorderSchedule {
  if(!isObject(input) || !validKeys(input,[
    'businessTimezone','slotMinutes','capacityPerSlot','minLeadMinutes',
    'maxDaysAhead','hours','closedDates',
  ]) || !validTimezone(input.businessTimezone) ||
      ![15,30,60].includes(input.slotMinutes as number) ||
      !Number.isSafeInteger(input.capacityPerSlot) || (input.capacityPerSlot as number)<1 ||
      (input.capacityPerSlot as number)>100 ||
      !Number.isSafeInteger(input.minLeadMinutes) || (input.minLeadMinutes as number)<120 ||
      (input.minLeadMinutes as number)>10080 ||
      !Number.isSafeInteger(input.maxDaysAhead) || (input.maxDaysAhead as number)<1 ||
      (input.maxDaysAhead as number)>30 ||
      !isObject(input.hours) || !validKeys(input.hours,weekdays) ||
      !Array.isArray(input.closedDates) || input.closedDates.length>60 ||
      input.closedDates.some(date=>!strictDate(date)) ||
      new Set(input.closedDates).size!==input.closedDates.length)
    throw new SquarePreorderError('INVALID_WINDOW');
  for(const key of weekdays){
    const window=input.hours[key];
    if(window===null)continue;
    if(!isObject(window) || !validKeys(window,['open','close']))throw new SquarePreorderError('INVALID_WINDOW');
    const start=parseTime(window.open),end=parseTime(window.close);
    if(start===null || end===null || start>=end)throw new SquarePreorderError('INVALID_WINDOW');
  }
  return input as unknown as PreorderSchedule;
}
export function preorderScheduleFromSettings(values:Readonly<Record<string,string|undefined>>):PreorderSchedule|null {
  if(values.SQUARE_PREORDERS_PREVIEW_ENABLED!=='true')return null;
  const raw=values.SQUARE_PREORDER_SCHEDULE_JSON;
  if(!raw)return null; // existing simple preorder preview remains usable
  if(raw.length>3000)throw new SquarePreorderError('INVALID_WINDOW');
  let decoded:unknown;
  try{decoded=JSON.parse(raw);}
  catch{throw new SquarePreorderError('INVALID_WINDOW');}
  return parsePreorderSchedule(decoded);
}
function localParts(formatter:Intl.DateTimeFormat, instant:number) {
  const part=Object.fromEntries(formatter.formatToParts(instant).map(i=>[i.type,i.value]));
  return {date:part.year+'-'+part.month+'-'+part.day,time:part.hour+':'+part.minute};
}
function validClock(now:number):boolean {return Number.isSafeInteger(now) && Number.isFinite(now) && now>=0;}
/**
 * Candidate slots only: no live POS hours validation, occupancy/reservations, inventory,
 * payment or calendar booking. Excludes duplicated DST fall-back wall times entirely.
 */
export function previewPreorderSlots(schedule:PreorderSchedule,date:string,now=Date.now()):PreorderSlotPreview {
  // Recheck even typed input because a merchant config might have changed.
  const policy=parsePreorderSchedule(schedule);
  if(!strictDate(date) || !validClock(now))throw new SquarePreorderError('INVALID_WINDOW');
  const startDate=Date.parse(date+'T00:00:00Z');
  const timeZone=policy.businessTimezone;
  const formatter=new Intl.DateTimeFormat('en-GB',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',hourCycle:'h23',
  });
  const result:PreorderSlot[]=[];
  if(!policy.closedDates.includes(date)){
    const weekday=weekdays[new Date(startDate).getUTCDay()]!;
    const hours=policy.hours[weekday];
    if(hours){
      const open=parseTime(hours.open)!,close=parseTime(hours.close)!;
      const step=policy.slotMinutes*60_000;
      // Search all possible global offsets (+/-14 h) to avoid DST arithmetic mistakes.
      const first=Math.ceil((startDate-14*3600_000)/step)*step;
      const last=startDate+38*3600_000;
      for(let t=first;t<last;t+=step){
        if(t<now+policy.minLeadMinutes*60_000 ||
           t>now+policy.maxDaysAhead*86400_000)continue;
        const local=localParts(formatter,t);
        if(local.date!==date)continue;
        const minutes=parseTime(local.time);
        if(minutes===null || minutes<open || minutes+policy.slotMinutes>close ||
            minutes%policy.slotMinutes!==0)continue;
        result.push({
          pickupAt:new Date(t).toISOString(),localDate:date,localTime:local.time,
          businessTimezone:timeZone,configuredCapacity:policy.capacityPerSlot,
          remainingCapacity:null,reservedQuantity:null,
          checkoutAvailable:false,capacityReservationRequired:true,
        });
      }
    }
  }
  const duplicate=new Map<string,number>();
  for(const slot of result)duplicate.set(slot.localTime,(duplicate.get(slot.localTime)??0)+1);
  const slots=result.filter(slot=>duplicate.get(slot.localTime)===1);
  slots.sort((a,b)=>a.pickupAt.localeCompare(b.pickupAt));
  if(slots.length>100)throw new SquarePreorderError('INVALID_WINDOW');
  return {mode:'scheduled-pickup-slots-preview',date,businessTimezone:timeZone,
    slots,capacityVerified:false,businessHoursVerified:false,checkoutAuthorized:false};
}
