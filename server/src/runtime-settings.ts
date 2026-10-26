import { publicOrigin } from './origin';

export function runtimeSettings(values: Readonly<Record<string, string | undefined>>, railway: boolean) {
  const port = Number(values.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  const origin = values.PUBLIC_ORIGIN ? publicOrigin(values.PUBLIC_ORIGIN, railway) : undefined;
  if (railway && !origin) throw new Error('Railway startup requires canonical HTTPS PUBLIC_ORIGIN');
  if (values.SQUARE_ENVIRONMENT && values.SQUARE_ENVIRONMENT !== 'sandbox') throw new Error('Production Square is disabled');
  return { port, host: railway ? '0.0.0.0' : '127.0.0.1', origin, native: railway || values.STARTER_STORAGE === 'postgres', sandbox: values.SQUARE_SANDBOX_REQUESTS_ENABLED === 'true' };
}
