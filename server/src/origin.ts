import type { Request } from 'express';

export function publicOrigin(value: string, requireHttps = false): string {
  let url: URL; try { url = new URL(value); } catch { throw new Error('A canonical PUBLIC_ORIGIN is required'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && (requireHttps || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('PUBLIC_ORIGIN must be HTTPS (or local loopback for development) without a path');
  return url.origin;
}
/** Configured origin is authoritative behind TLS termination; forwarded/host headers cannot redefine it. */
export function validWriteOrigin(req: Request, configured?: string, requireHeader = false): boolean {
  const origin = req.get('Origin');
  if (!origin) return !requireHeader && !configured;
  return origin === (configured ?? `http://${req.get('Host')}`);
}
export const sandboxCsp = "default-src 'self'; script-src 'self' https://sandbox.web.squarecdn.com; frame-src https://sandbox.web.squarecdn.com; connect-src 'self' https://sandbox.web.squarecdn.com https://pci-connect.squareupsandbox.com https://o160250.ingest.sentry.io; style-src 'self' 'unsafe-inline' https://sandbox.web.squarecdn.com; font-src 'self' https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net; img-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
