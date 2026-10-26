/**
 * Static, secret-safe setup diagnostics for the lean Railway template.
 * No imports, file access, process mutation, database connections or provider calls.
 * Runtime validators remain authoritative; a successful report is not acceptance.
 * Shape rules were reviewed against main 935c10a. See docs/TEMPLATE-SETUP.md.
 */
export const profiles = Object.freeze(['local-demo', 'railway-demo', 'square-sandbox', 'merchant-sandbox', 'merchant-production']);

const squareFields = Object.freeze([
  'SQUARE_APPLICATION_ID', 'SQUARE_LOCATION_ID', 'SQUARE_SANDBOX_ACCESS_TOKEN',
  'SQUARE_SANDBOX_MERCHANT_ID', 'SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY',
]);
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);

/** @param {unknown} value */
function supplied(value) { return typeof value === 'string' && value.length > 0; }
/** A placeholder is not a credential or a resolved Railway reference. */
function placeholder(value) {
  return /\$\{\{|^\s*(?:replace[-_ ]?me|change[-_ ]?me|your[-_ ].*|<.*>)\s*$/i.test(value);
}

/**
 * @param {Readonly<Record<string, string | undefined>>} values
 * @param {{profile?: string, fresh?: boolean, nodeVersion?: string}} options
 */
export function inspectSetup(values = {}, options = {}) {
  const { profile = 'local-demo', fresh = false, nodeVersion = process.versions.node } = options;
  if (!profiles.includes(profile) || typeof fresh !== 'boolean' || (fresh && profile === 'local-demo')) {
    throw new TypeError('Choose a supported profile; fresh validation requires a Railway profile.');
  }
  /** @type {{code:string, status:'pass'|'fail'|'warning', variable:string|null, message:string}[]} */
  const checks = [];
  const check = (code, ok, variable, message) => checks.push({ code, status: ok ? 'pass' : 'fail', variable, message });
  const warn = (code, variable, message) => checks.push({ code, status: 'warning', variable, message });
  const get = name => typeof values[name] === 'string' ? values[name] : '';
  const hosted = profile !== 'local-demo';
  const production = profile === 'merchant-production';
  const merchant = profile === 'merchant-sandbox' || production;
  const merchantWebhookPath = get('SQUARE_MERCHANT_WEBHOOK_PATH') || '/api/commerce/webhooks';
  if(merchant) check('MERCHANT_WEBHOOK_PATH_VALID',['/api/commerce/webhooks','/api/sandbox/webhooks'].includes(merchantWebhookPath),'SQUARE_MERCHANT_WEBHOOK_PATH','Use the merchant callback default or explicitly preserve the existing /api/sandbox/webhooks callback; no other path is allowed.');
  const sandbox = profile === 'square-sandbox' || profile === 'merchant-sandbox';

  const version = /^(\d+)\.(\d+)\.\d+$/.exec(String(nodeVersion));
  check('NODE_SUPPORTED', Boolean(version && ((Number(version[1]) === 22 && Number(version[2]) >= 12) || Number(version[1]) === 24)), null,
    'Use Node 22.12 or newer within 22.x, or Node 24.x, as pinned by package.json.');

  const port = get('PORT');
  check('PORT_VALID', values.PORT === undefined || (/^[0-9]+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535), 'PORT',
    'Omit PORT or use a whole decimal port from 1 to 65535. Railway supplies the runtime port.');

  const environment = get('SQUARE_ENVIRONMENT');
  check('SQUARE_ENVIRONMENT_VALID', production ? environment === 'production' : sandbox ? environment === 'sandbox' : !environment || environment === 'sandbox', 'SQUARE_ENVIRONMENT',
    production ? 'The merchant production profile requires the explicit production environment and its separately approved enable gate; this checker does not activate it.' : 'This profile supports sandbox only. Production remains disabled.');
  const activation = get('SQUARE_SANDBOX_REQUESTS_ENABLED');
  check('SQUARE_ACTIVATION_EXPLICIT', sandbox ? activation === 'true' : !activation || activation === 'false', 'SQUARE_SANDBOX_REQUESTS_ENABLED',
    sandbox ? 'The sandbox runtime requires the exact value true. This checker does not set it, activate the runtime or authorize calls.'
      : production ? 'Keep sandbox requests absent or exactly false in the production profile. This checker does not activate production.' : 'A demo profile requires this setting to be absent or exactly false; it must not silently activate Square.');

  if(production) check('PRODUCTION_ACTIVATION_EXPLICIT',get('SQUARE_PRODUCTION_PAYMENTS_ENABLED')==='true','SQUARE_PRODUCTION_PAYMENTS_ENABLED','Production configuration requires the exact true gate after separate action-time authorization. Static validation never grants that authorization or changes this value.');

  const storage = get('STARTER_STORAGE');
  check('STORAGE_PROFILE_VALID', hosted ? !storage || storage === 'postgres' : !storage, 'STARTER_STORAGE',
    hosted ? 'Railway startup selects native PostgreSQL. Omit STARTER_STORAGE or set it to postgres.'
      : 'This profile checks default in-memory startup; omit STARTER_STORAGE. Native storage needs a Railway profile.');

  const originValue = get('PUBLIC_ORIGIN');
  let originValid = !hosted && !originValue;
  if (originValue) {
    try {
      const url = new URL(originValue);
      originValid = !placeholder(originValue) && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
        && (url.protocol === 'https:' || (!hosted && url.protocol === 'http:' && loopback.has(url.hostname)));
    } catch { originValid = false; }
  }
  check('PUBLIC_ORIGIN_VALID', originValid, 'PUBLIC_ORIGIN', hosted
    ? 'Use the canonical HTTPS application origin without user information, a path, query or fragment. Resolve Railway references first.'
    : 'An optional local origin must be HTTPS or loopback HTTP, without user information, a path, query or fragment.');

  // Public build variables must never contain server credentials. Never echo dynamic names or values.
  const browserSecret = Object.entries(values).some(([name, value]) => supplied(value)
    && /^(?:VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(name)
    && /(?:ACCESS_TOKEN|SIGNATURE_KEY|PASSWORD|DATABASE_URL|PRIVATE_KEY|CLIENT_SECRET|SESSION_KEY)/.test(name));
  check('NO_BROWSER_SECRETS', !browserSecret, null,
    'Do not place access tokens, signing keys, passwords or database credentials in public/browser build variables.');

  if (hosted) {
    if (merchant) {
      check('MERCHANT_DATASET_REQUIRED', get('STARTER_DATASET') === 'merchant-catalog-v1', 'STARTER_DATASET', 'Use only a separately initialized merchant-catalog-v1 database; never adopt the synthetic pilot.');
      check('MERCHANT_COMMERCE_EXPLICIT', get('SQUARE_MERCHANT_COMMERCE_ENABLED') === 'true', 'SQUARE_MERCHANT_COMMERCE_ENABLED', 'The merchant entrypoint requires exact true; this checker does not activate it.');
      check('MERCHANT_DATABASE_DISTINCT', supplied(values.MERCHANT_DATABASE_URL) && get('MERCHANT_DATABASE_URL') !== get('DATABASE_URL'), 'MERCHANT_DATABASE_URL', 'A separate merchant database URL is required, distinct from the synthetic DATABASE_URL.');
      check('DATABASE_BOOTSTRAP_VALID', !get('STARTER_DB_BOOTSTRAP'), 'STARTER_DB_BOOTSTRAP', 'Merchant schema setup is an explicit owner-run command, not synthetic startup bootstrap. Omit STARTER_DB_BOOTSTRAP.');
      const sessionKey = get('MERCHANT_ADMIN_SESSION_KEY');
      check('MERCHANT_SESSION_KEY_VALID', /^[A-Za-z0-9_-]{43}$/.test(sessionKey) && Buffer.from(sessionKey, 'base64url').length === 32 && Buffer.from(sessionKey, 'base64url').toString('base64url') === sessionKey && !placeholder(sessionKey), 'MERCHANT_ADMIN_SESSION_KEY', 'Supply an already-authorized server-only canonical 32-byte base64url session key. This check creates or changes no credential.');
      for (const [name, max] of [['MERCHANT_NAME',100],['MERCHANT_PICKUP_LABEL',100],['MERCHANT_PICKUP_INSTRUCTIONS',500]]) {
        const text=get(name);
        check(name + '_VALID', Boolean(text.trim()) && text.length <= max && !/[\x00-\x1f\x7f]/.test(text) && !placeholder(text), name, 'Provide reviewed merchant presentation and pickup text within its documented length limit; do not use secrets or placeholders.');
      }
      warn('MERCHANT_INSTALLATION_NOT_RUN', null, 'Use start:merchant only after explicit merchant:db:setup and administrator provisioning. No schema, staff account, import, stock activation or merchant acceptance was performed.');
    } else {
    check('SYNTHETIC_DATASET_REQUIRED', get('STARTER_DATASET') === 'synthetic-retail-v1', 'STARTER_DATASET',
      'Current runtime requires its isolated synthetic-retail-v1 dataset. A merchant-data/production path is a separate release gate.');
    const bootstrap = get('STARTER_DB_BOOTSTRAP');
    check('DATABASE_BOOTSTRAP_VALID', fresh ? bootstrap === 'empty-synthetic-only' : !bootstrap || bootstrap === 'empty-synthetic-only', 'STARTER_DB_BOOTSTRAP',
      fresh ? 'Fresh database initialization requires empty-synthetic-only. The runtime still refuses unknown data and preserves existing rows.'
        : 'Omit bootstrap for an existing database, or use the exact empty-synthetic-only acknowledgement for a reviewed empty database.');

    }
    const databaseVariable = merchant ? 'MERCHANT_DATABASE_URL' : 'DATABASE_URL';
    const databaseValue = get(databaseVariable);
    let databaseValid = false;
    let privateDatabase = false;
    let hostedLoopback = false;
    if (databaseValue && !placeholder(databaseValue)) {
      try {
        const url = new URL(databaseValue);
        hostedLoopback = loopback.has(url.hostname);
        privateDatabase = url.hostname.endsWith('.railway.internal');
        const local = hostedLoopback || privateDatabase;
        databaseValid = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname)
          && url.pathname.length >= 2 && !url.hash && !(merchant ? /urban|churn|synthetic/i : /urban|churn/i).test(url.hostname + url.pathname)
          && (!url.search || ['?sslmode=require', '?sslmode=verify-full'].includes(url.search))
          && (local || url.search === '?sslmode=verify-full');
      } catch { databaseValid = false; }
    }
    check('DATABASE_URL_VALID', databaseValid, databaseVariable,
      'Use a dedicated PostgreSQL database URL. Public remote connections require sslmode=verify-full; unsupported URL options and unrelated merchant targets are refused.');
    check('DATABASE_HOST_REACHABLE_BY_DESIGN', !hostedLoopback, databaseVariable,
      'For an app-plus-database Railway template, do not point the application at its own loopback host. Use the database service reference.');
    if (databaseValid && !privateDatabase && !hostedLoopback) warn('PRIVATE_DATABASE_RECOMMENDED', databaseVariable,
      'This is a remote verified-TLS URL. Prefer the Railway database private-network reference for the two-service template.');
    warn('DATABASE_NOT_CONNECTED', null,
      'No database connection, schema inspection, migration, seed or readiness request was performed. Runtime guards still apply.');
  } else if (get('DATABASE_URL')) {
    warn('DATABASE_IGNORED_IN_LOCAL_DEMO', 'DATABASE_URL',
      'Default in-memory startup does not use this database URL. No database was contacted.');
  }

  if (production) {
    const rules = [
      ['SQUARE_PRODUCTION_APPLICATION_ID','PRODUCTION_APPLICATION_VALID',/^sq0id[bp]-[A-Za-z0-9_-]{1,128}$/,'Use the explicitly approved production application identity, not a sandbox or generic application variable.'],
      ['SQUARE_PRODUCTION_LOCATION_ID','PRODUCTION_LOCATION_VALID',/^[A-Za-z0-9_-]{1,192}$/,'Supply the production location belonging to the approved production merchant.'],
      ['SQUARE_PRODUCTION_MERCHANT_ID','PRODUCTION_MERCHANT_VALID',/^[A-Za-z0-9_-]{1,192}$/,'Supply the explicitly approved production merchant identity.'],
      ['SQUARE_PRODUCTION_ACCESS_TOKEN','PRODUCTION_TOKEN_FORMAT_VALID',/^\S{16,4096}$/,'Supply a separately approved server-only production access token. Format checks cannot verify its ownership, permissions or environment.'],
      ['SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY','PRODUCTION_SIGNATURE_PRESENT',/^\S{16,4096}$/,'Supply the separately approved production signing key for the exact canonical callback URL.'],
    ];
    for(const [name,code,rule,message] of rules){const value=get(name);check(code,Boolean(value&&!placeholder(value)&&rule.test(value)),name,message);}
    check('PRODUCTION_TOKEN_DISTINCT',Boolean(get('SQUARE_PRODUCTION_ACCESS_TOKEN'))&&!get('SQUARE_PRODUCTION_ACCESS_TOKEN').startsWith('sandbox-')&&get('SQUARE_PRODUCTION_ACCESS_TOKEN')!==get('SQUARE_SANDBOX_ACCESS_TOKEN'),'SQUARE_PRODUCTION_ACCESS_TOKEN','Never alias or borrow the sandbox access token for production.');
    check('PRODUCTION_SIGNATURE_DISTINCT',Boolean(get('SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY'))&&get('SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY')!==get('SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY'),'SQUARE_PRODUCTION_WEBHOOK_SIGNATURE_KEY','Never alias the sandbox webhook signing key for production.');
    warn('PRODUCTION_ACCEPTANCE_NOT_RUN',null,'No production credential, merchant/location association, webhook, order, payment, refund or live activation was tested. Configuration validity is not payment acceptance or launch readiness.');
  } else if (sandbox) {
    const rules = [
      ['SQUARE_APPLICATION_ID', 'SANDBOX_APPLICATION_VALID', /^sandbox-sq0idb-[A-Za-z0-9_-]+$/, 'Use the application ID from the dedicated Square Sandbox application.'],
      ['SQUARE_LOCATION_ID', 'SANDBOX_LOCATION_VALID', /^[A-Za-z0-9]{1,64}$/, 'Use the location ID belonging to that Sandbox seller account.'],
      ['SQUARE_SANDBOX_ACCESS_TOKEN', 'SANDBOX_TOKEN_FORMAT_VALID', /^\S{16,}$/, 'Supply the Sandbox access token through a server-only secret variable. A format check cannot prove token ownership or environment.'],
      ['SQUARE_SANDBOX_MERCHANT_ID', 'SANDBOX_MERCHANT_VALID', /^[A-Za-z0-9_-]{1,192}$/, 'Supply the merchant ID for the same Sandbox seller account.'],
      ['SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY', 'SANDBOX_SIGNATURE_PRESENT', /^\S+$/, 'Supply the signing key for the Sandbox webhook subscription using the application HTTPS origin and /api/sandbox/webhooks.'],
    ];
    for (const [name, code, rule, message] of rules) {
      const value = get(name);
      check(code, Boolean(value && !placeholder(value) && rule.test(value)), name, merchant && name === 'SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY' ? 'Supply the signing key for the exact canonical HTTPS origin plus /api/commerce/webhooks (default), or the explicitly preserved /api/sandbox/webhooks callback.' : message);
    }
    warn('SQUARE_ACCEPTANCE_NOT_RUN', null,
      'No token, merchant/location association, SDK, payment, order, refund or callback has been verified against Square. Explicit authorized sandbox acceptance is still required.');
  } else if (squareFields.some(name => supplied(values[name]))) {
    warn('STAGED_CREDENTIALS_DO_NOT_ENABLE_PAYMENTS', null,
      'Square configuration is present but is not validated for use in this demo profile. Adding credentials alone does not authorize provider activity.');
  }
  warn('ADMIN_ACCESS_UNCHANGED', null,
    'Staff APIs remain subject to the existing trusted-session guard. This check creates no users, grants or passwords.');

  return {
    schemaVersion: 1,
    profile,
    startCommand: merchant ? 'pnpm start:merchant' : hosted ? 'pnpm start:railway' : 'pnpm dev',
    validation: 'static-only',
    configurationValid: checks.every(item => item.status !== 'fail'),
    databaseConnectionVerified: false,
    squareConnectionVerified: false,
    paymentAcceptanceVerified: false,
    productionReady: false,
    activationChanged: false,
    checks,
  };
}

