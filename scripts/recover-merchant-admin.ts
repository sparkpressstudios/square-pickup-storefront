/** Explicit operator account recovery; never a startup hook or public password-reset endpoint. */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SqlDatabase } from '../db/sql-database';
import { openNativeMerchantDatabase } from '../db/native-merchant-database';
import { merchantPaymentConfiguration } from '../server/src/merchant-payment-config';
import { resetExistingMerchantAdmin } from '../server/src/merchant-staff-auth';

export async function readRecoveryPassword(input: AsyncIterable<Buffer | string>, isTTY: boolean): Promise<string> {
  if (isTTY) throw new Error('Non-echoing secret input required');
  const chunks: Buffer[] = []; let bytes = 0;
  try {
    for await (const chunk of input) { const part = Buffer.from(chunk); chunks.push(part); bytes += part.byteLength; if (bytes > 132) throw new Error('Input rejected'); }
    const joined = Buffer.concat(chunks); try { return joined.toString('utf8').replace(/\r?\n$/, ''); } finally { joined.fill(0); }
  } finally { for (const chunk of chunks) chunk.fill(0); }
}
export interface RecoveryDependencies {
  readPassword(): Promise<string>;
  open(values: Readonly<Record<string, string | undefined>>, commerce: boolean): Promise<{ db: SqlDatabase; close(): Promise<void> }>;
  write(message: string): void;
}
export async function runMerchantAdminRecovery(args: string[], values: Readonly<Record<string, string | undefined>>, dependencies: RecoveryDependencies): Promise<number> {
  if (args.length !== 1 || args[0] !== '--password-stdin') { dependencies.write('Recovery refused: explicit --password-stdin is required.\n'); return 2; }
  try {
    merchantPaymentConfiguration(values);
    const password = await dependencies.readPassword();
    const handle = await dependencies.open(values, values.SQUARE_MERCHANT_COMMERCE_ENABLED === 'true');
    try { await resetExistingMerchantAdmin(handle.db, values, password); } finally { await handle.close(); }
    dependencies.write('Existing merchant administrator password reset; all merchant sessions revoked. No credentials printed.\n'); return 0;
  } catch { dependencies.write('Merchant administrator recovery refused. Verify owner authorization, recognized merchant/environment binding, existing enabled administrator and password policy without logging secrets.\n'); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runMerchantAdminRecovery(process.argv.slice(2), process.env, {
    readPassword: () => readRecoveryPassword(process.stdin, Boolean(process.stdin.isTTY)),
    open: openNativeMerchantDatabase,
    write: message => process.stdout.write(message),
  }).then(code => { process.exitCode = code; });
}
