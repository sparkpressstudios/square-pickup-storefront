export const profiles:readonly string[];
export function inspectSetup(values?:Readonly<Record<string,string|undefined>>,options?:{profile?:string;fresh?:boolean;nodeVersion?:string}):{
 schemaVersion:number;profile:string;startCommand:string;validation:string;configurationValid:boolean;
 databaseConnectionVerified:false;squareConnectionVerified:false;paymentAcceptanceVerified:false;productionReady:false;activationChanged:false;
 checks:Array<{code:string;status:'pass'|'fail'|'warning';variable:string|null;message:string}>;
};
