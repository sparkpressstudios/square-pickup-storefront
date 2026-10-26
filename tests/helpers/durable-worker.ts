import type { CheckoutRequest } from '../../shared/checkout';
import { DurableCheckoutService, type DurableStore } from '../../server/src/durable-checkout';

// Test-only IPC, not a database network listener. One owner hosts PGlite's connection.
let sequence = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function rpc<T>(method: string, args: unknown[] = []): Promise<T> {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve: (value) => resolve(value as T), reject });
    process.send!({ kind: 'database', id, method, args });
  });
}
const store: DurableStore = {
  mode: 'mock-only', getCatalog: () => rpc('getCatalog'), getSessionId: () => rpc('getSessionId'),
  reserve: (input) => rpc('reserve', [input]), simulatePayment: (id) => rpc('simulatePayment', [id]),
  finish: (id, payment) => rpc('finish', [id, payment]), decline: (id) => rpc('decline', [id]), uncertain: (id) => rpc('uncertain', [id]),
};
process.on('message', (raw: unknown) => {
  const message = raw as { kind: string; id: number; result?: unknown; error?: { message: string; code?: string; status?: number }; input?: CheckoutRequest; fault?: string };
  if (message.kind === 'database-result') {
    const waiting = pending.get(message.id); pending.delete(message.id);
    if (message.error) waiting?.reject(Object.assign(new Error(message.error.message), { code: message.error.code, status: message.error.status }));
    else waiting?.resolve(message.result);
  }
  if (message.kind === 'start') {
    const service = new DurableCheckoutService(store, {
      afterReserve: async () => { if (message.fault === 'after-reserve') process.exit(41); },
      afterPayment: async () => { if (message.fault === 'after-payment') process.exit(42); },
    });
    void service.checkout(message.input).then(
      (result) => process.send!({ kind: 'complete', result }, () => process.disconnect()),
      (error: Error & { code?: string }) => process.send!({ kind: 'complete', error: { message: error.message, code: error.code } }, () => process.disconnect()),
    );
  }
});
process.send!({ kind: 'ready' });
