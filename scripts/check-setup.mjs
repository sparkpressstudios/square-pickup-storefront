#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectSetup, profiles } from './lib/template-setup.mjs';

const usage = 'Usage: node scripts/check-setup.mjs [--profile local-demo|railway-demo|square-sandbox|merchant-sandbox|merchant-production] [--fresh] [--json]';

/** Parse only known flags. Never echo arbitrary arguments, which may contain secrets. */
export function parseArguments(args) {
  const result = { profile: 'local-demo', fresh: false, json: false, help: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--' && !seen.has('--')) { seen.add('--'); continue; }
    if (!['--profile', '--fresh', '--json', '--help'].includes(flag) || seen.has(flag)) throw new Error(usage);
    seen.add(flag);
    if (flag === '--profile') {
      const value = args[++i];
      if (!profiles.includes(value)) throw new Error(usage);
      result.profile = value;
    } else if (flag === '--fresh') result.fresh = true;
    else if (flag === '--json') result.json = true;
    else result.help = true;
  }
  if (result.fresh && result.profile === 'local-demo') throw new Error(usage);
  return result;
}

export function formatReport(report) {
  const lines = [
    `Square Commerce Starter setup: ${report.profile}`,
    report.configurationValid ? 'Static configuration checks passed.' : 'Static configuration checks failed.',
    'No database or Square calls were made. Payment acceptance and production readiness are NOT verified.',
    ...report.checks.map(item => `[${item.status.toUpperCase()}] ${item.code}${item.variable ? ` (${item.variable})` : ''}: ${item.message}`),
  ];
  return lines.join('\n') + '\n';
}

/** Returns an exit code; injected I/O keeps the CLI testable without process exits. */
export function run(args, values, write = text => process.stdout.write(text)) {
  let options;
  try { options = parseArguments(args); }
  catch {
    write(args.includes('--json') ? JSON.stringify({ error: 'INVALID_ARGUMENTS', message: usage }) + '\n' : usage + '\n');
    return 2;
  }
  if (options.help) { write(usage + '\nThis command reads only the supplied process environment. It never loads .env files, activates providers or changes data.\n'); return 0; }
  try {
    const report = inspectSetup(values, options);
    write(options.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
    return report.configurationValid ? 0 : 1;
  } catch {
    // Do not log exception text or input values: both can contain credentials.
    write(options.json ? JSON.stringify({ error: 'SETUP_CHECK_FAILED', message: 'Unable to inspect configuration safely.' }) + '\n'
      : 'Unable to inspect configuration safely. No settings were changed.\n');
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2), process.env);
}

