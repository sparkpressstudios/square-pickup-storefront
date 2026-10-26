/** Native acceptance may target loopback, or an explicitly approved Railway sandbox's private network. */
export function nativeAcceptanceSettings(values: Readonly<Record<string, string | undefined>>) {
  let url: URL;
  try { url = new URL(values.STARTER_TEST_DATABASE_URL ?? ''); } catch { throw new Error('Invalid isolated native acceptance configuration; connection details withheld'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !/^\/square_starter_test_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) throw new Error('Native acceptance requires a dedicated square_starter_test_* database without URL options');
  const local = values.STARTER_NATIVE_TESTS === 'isolated-local' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  const railway = values.STARTER_NATIVE_TESTS === 'isolated-railway' && url.hostname.endsWith('.railway.internal') &&
    values.RAILWAY_ENVIRONMENT_NAME === 'sandbox' && values.STARTER_DATASET === 'synthetic-retail-v1' && values.SQUARE_SANDBOX_REQUESTS_ENABLED === 'false' &&
    /^[0-9a-f-]{36}$/.test(values.STARTER_NATIVE_EXPECTED_PROJECT_ID ?? '') && values.STARTER_NATIVE_EXPECTED_PROJECT_ID === values.RAILWAY_PROJECT_ID &&
    /^[0-9a-f-]{36}$/.test(values.STARTER_NATIVE_EXPECTED_ENVIRONMENT_ID ?? '') && values.STARTER_NATIVE_EXPECTED_ENVIRONMENT_ID === values.RAILWAY_ENVIRONMENT_ID;
  if (!local && !railway) throw new Error('Native acceptance requires explicit isolated-local or matching approved Railway sandbox context');
  return { connectionString: values.STARTER_TEST_DATABASE_URL!, requireSyntheticMarker: railway };
}
