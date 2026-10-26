#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBuyerRailwayPlan } from './lib/buyer-railway-plan.mjs';

/** No paths, arbitrary arguments, setting values or exception messages are printed. */
export async function run(args, values, write = text => process.stdout.write(text), read = readFile) {
  if (args.length !== 2 || args[0] !== '--plan') {
    write('Usage: node scripts/check-buyer-railway-plan.mjs --plan <operator-settings.json>\n'); return 2;
  }
  try {
    const raw = await read(args[1], 'utf8');
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16 * 1024) throw new Error('Invalid input');
    const report = inspectBuyerRailwayPlan(JSON.parse(raw), values);
    write(JSON.stringify(report, null, 2) + '\n');
    return report.configurationValid ? 0 : 1;
  } catch {
    write('Buyer plan validation failed safely. No settings were changed; input values are not printed.\n'); return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2), process.env);
