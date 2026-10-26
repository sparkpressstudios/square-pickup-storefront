/**
 * Explicit fresh-merchant-only one-time administrator provisioning.
 * Run with --password-stdin using a trusted secret input stream; never paste
 * a password into command arguments, Railway variables, code or chat.
 * This script is not called from startup, build, healthcheck or deployment hooks.
 */
import { openNativeMerchantDatabase } from '../db/native-merchant-database';
import { provisionInitialMerchantAdmin } from '../server/src/merchant-staff-auth';

async function stdinPassword(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('Use a trusted non-echoing password input stream.');
  let total=0;const parts:Buffer[]=[];
  for await (const part of process.stdin) {
    const b=Buffer.isBuffer(part)?part:Buffer.from(part);
    total+=b.byteLength;
    if(total>132)throw new Error('Password input exceeds the allowed limit.');
    parts.push(b);
  }
  return Buffer.concat(parts).toString('utf8').replace(/\r?\n$/,'');
}
async function main() {
  if (process.argv.length!==3 || process.argv[2]!=='--password-stdin' ||
      process.env.STARTER_DATASET!=='merchant-catalog-v1')
    throw new Error('This command requires an explicitly configured fresh merchant database and --password-stdin.');
  const password=await stdinPassword();
  const handle=await openNativeMerchantDatabase(process.env,process.env.SQUARE_MERCHANT_COMMERCE_ENABLED==='true');
  try {
    await provisionInitialMerchantAdmin(handle.db,process.env,password);
    process.stdout.write('Initial merchant administrator was provisioned in the separate merchant database. No password or session credential was printed.\n');
  }finally{await handle.close();}
}
try {await main();}
catch {
  process.stderr.write('Merchant administrator provisioning refused. Confirm fresh database marker, one-time authorization and password policy without logging secrets.\n');
  process.exitCode=1;
}

