import { createHash, randomUUID } from 'node:crypto';
import type { SqlDatabase, SqlExecutor } from '../../db/sql-database';
import { validateCatalog, type Catalog, type Product, type Variant } from '../../shared/catalog';
import { CheckoutError, parseCartRequest, parseCheckoutRequest, quoteCart, type CheckoutRequest, type DemoQuote, type DemoReceipt } from '../../shared/checkout';
import { MockDecline, type MockPaymentResult } from './mock-square';

export interface StoredAttempt {
  attemptId: string; checkoutId: string; sessionId: string; fingerprint: string;
  quote: DemoQuote; state: 'reserved' | 'simulated' | 'declined' | 'uncertain';
  mockPaymentKey: string; receipt: DemoReceipt | null;
}
export interface DurableStore {
  readonly mode: 'mock-only';
  getCatalog(): Promise<Catalog>;
  getSessionId(): Promise<string>;
  reserve(input: CheckoutRequest): Promise<StoredAttempt>;
  simulatePayment(attemptId: string): Promise<MockPaymentResult>;
  finish(attemptId: string, payment: MockPaymentResult): Promise<DemoReceipt>;
  decline(attemptId: string): Promise<boolean>;
  uncertain(attemptId: string): Promise<void>;
}
const attemptColumns = `attempt_id AS "attemptId", checkout_id AS "checkoutId", session_id AS "sessionId", fingerprint, quote, state, mock_payment_key AS "mockPaymentKey", receipt`;

export async function readCatalog(tx: SqlExecutor): Promise<Catalog> {
  const products = await tx.query<Omit<Product, 'variants'>>('SELECT id, name, description, category, options FROM catalog_products ORDER BY id');
  const variants = await tx.query<Variant & { productId: string; currency: string }>('SELECT id, product_id AS "productId", sku, selections, currency, price_minor AS "priceMinor", stock_quantity AS "stockQuantity", enabled FROM catalog_variants ORDER BY id');
  if (variants.rows.some((variant) => variant.currency !== 'USD')) throw new Error('Unsupported database currency');
  const catalog: Catalog = { currency: 'USD', products: products.rows.map((product) => ({ ...product, variants: variants.rows.filter((variant) => variant.productId === product.id).map(({ productId: _productId, currency: _currency, ...variant }) => variant) })) };
  validateCatalog(catalog);
  return catalog;
}
async function readAttempt(tx: SqlExecutor, id: string): Promise<StoredAttempt> {
  const result = await tx.query<StoredAttempt>(`SELECT ${attemptColumns} FROM checkout_attempts WHERE attempt_id = $1 FOR UPDATE`, [id]);
  if (!result.rows[0]) throw new Error('Missing durable attempt');
  return result.rows[0];
}

/** Parameterized PostgreSQL transactions. The only payment effect is a local mock ledger. */
export class PostgresCheckoutStore implements DurableStore {
  readonly mode = 'mock-only' as const;
  constructor(private readonly db: SqlDatabase) {}

  async getCatalog(): Promise<Catalog> {
    return this.db.transaction(async (tx) => {
      await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      return readCatalog(tx);
    });
  }
  async getSessionId(): Promise<string> {
    const result = await this.db.query<{ session_id: string; dataset: string }>('SELECT session_id, dataset FROM demo_database_state WHERE singleton = true');
    if (result.rows[0]?.dataset !== 'synthetic-retail-v1') throw new Error('Not a synthetic demo database');
    return result.rows[0].session_id;
  }
  async reserve(input: CheckoutRequest): Promise<StoredAttempt> {
    const request = parseCheckoutRequest(input);
    const fingerprint = createHash('sha256').update(JSON.stringify({ items: request.items, currency: request.currency, fulfillment: request.fulfillment, expectedTotalMinor: request.expectedTotalMinor })).digest('hex');
    return this.db.transaction(async (tx) => {
      // Serialize creation/replay for this key even when no attempt row exists yet.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [request.attemptId]);
      if ((await tx.query('SELECT attempt_id FROM sandbox_checkout_attempts WHERE attempt_id=$1', [request.attemptId])).rows.length) throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This attempt belongs to another checkout mode.', 409);
      const session = await tx.query<{ session_id: string; dataset: string }>('SELECT session_id, dataset FROM demo_database_state WHERE singleton = true');
      if (session.rows[0]?.dataset !== 'synthetic-retail-v1' || session.rows[0].session_id !== request.demoSessionId) throw new CheckoutError('DEMO_SESSION_EXPIRED', 'This request belongs to another demo database. Review a new cart.', 409);
      const existing = await tx.query<StoredAttempt>(`SELECT ${attemptColumns} FROM checkout_attempts WHERE attempt_id = $1 FOR UPDATE`, [request.attemptId]);
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint) throw new CheckoutError('IDEMPOTENCY_CONFLICT', 'This attempt already belongs to another cart or total.', 409);
        return existing.rows[0];
      }
      const count = await tx.query<{ count: number }>('SELECT count(*)::integer AS count FROM checkout_attempts');
      if (count.rows[0]!.count >= 500) throw new CheckoutError('DEMO_LIMIT_REACHED', 'This local database reached its demo attempt limit.', 503);
      // Stable lock order avoids opposite-order cart deadlocks on a native server.
      await tx.query('SELECT id FROM catalog_variants WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [request.items.map((item) => item.variantId).sort()]);
      const quote: DemoQuote = { ...quoteCart(await readCatalog(tx), request), demoSessionId: request.demoSessionId };
      if (quote.totalMinor !== request.expectedTotalMinor) throw new CheckoutError('PRICE_CHANGED', 'The submitted total differs from the current database quote.', 409);
      const checkoutId = randomUUID();
      await tx.query("INSERT INTO checkout_attempts(attempt_id,checkout_id,session_id,fingerprint,quote,state,mock_payment_key) VALUES ($1,$2,$3,$4,$5::jsonb,'reserved',$6)", [request.attemptId, checkoutId, request.demoSessionId, fingerprint, JSON.stringify(quote), `durable-mock:${checkoutId}`]);
      for (const line of quote.lines) {
        const updated = await tx.query('UPDATE catalog_variants SET stock_quantity = stock_quantity - $2 WHERE id = $1 AND enabled = true AND stock_quantity >= $2 RETURNING id', [line.variantId, line.quantity]);
        if (updated.rows.length !== 1) throw new CheckoutError('INSUFFICIENT_STOCK', 'Demo stock changed; review the cart again.', 409);
        await tx.query("INSERT INTO inventory_reservations(attempt_id,variant_id,quantity,state) VALUES ($1,$2,$3,'reserved')", [request.attemptId, line.variantId, line.quantity]);
      }
      return readAttempt(tx, request.attemptId);
    });
  }

  async simulatePayment(attemptId: string): Promise<MockPaymentResult> {
    return this.db.transaction(async (tx) => {
      const attempt = await readAttempt(tx, attemptId);
      if (attempt.state === 'declined') throw new CheckoutError('MOCK_DECLINED', 'This mocked checkout was declined.', 402);
      const paymentId = `mock_${createHash('sha256').update(attempt.mockPaymentKey).digest('hex').slice(0, 24)}`;
      await tx.query('INSERT INTO mock_payment_ledger(idempotency_key,checkout_id,payment_id,amount_minor,currency) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (idempotency_key) DO NOTHING', [attempt.mockPaymentKey, attempt.checkoutId, paymentId, attempt.quote.totalMinor, 'USD']);
      const ledger = await tx.query<{ payment_id: string; amount_minor: number; currency: string }>('SELECT payment_id,amount_minor,currency FROM mock_payment_ledger WHERE idempotency_key = $1', [attempt.mockPaymentKey]);
      if (ledger.rows[0]?.amount_minor !== attempt.quote.totalMinor || ledger.rows[0].currency !== 'USD') throw new Error('Mock ledger amount conflict');
      return { id: ledger.rows[0].payment_id, status: 'simulated' };
    });
  }

  async finish(attemptId: string, payment: MockPaymentResult): Promise<DemoReceipt> {
    return this.db.transaction(async (tx) => {
      const attempt = await readAttempt(tx, attemptId);
      if (attempt.receipt) return attempt.receipt;
      if (attempt.state === 'declined') throw new CheckoutError('MOCK_DECLINED', 'This mocked checkout was declined.', 402);
      const ledger = await tx.query<{ payment_id: string; amount_minor: number; currency: string }>('SELECT payment_id,amount_minor,currency FROM mock_payment_ledger WHERE idempotency_key = $1 AND checkout_id = $2', [attempt.mockPaymentKey, attempt.checkoutId]);
      const entry = ledger.rows[0];
      if (!entry || entry.payment_id !== payment.id || payment.status !== 'simulated' || entry.amount_minor !== attempt.quote.totalMinor || entry.currency !== 'USD') throw new Error('Cannot finalize without matching durable mock evidence');
      const receipt: DemoReceipt = { ...attempt.quote, checkoutId: attempt.checkoutId, attemptId: attempt.attemptId, mockPaymentId: entry.payment_id, status: 'simulated', fulfillmentAuthorized: false };
      await tx.query("UPDATE checkout_attempts SET state='simulated', receipt=$2::jsonb WHERE attempt_id=$1", [attemptId, JSON.stringify(receipt)]);
      await tx.query("UPDATE inventory_reservations SET state='committed' WHERE attempt_id=$1 AND state='reserved'", [attemptId]);
      return receipt;
    });
  }

  async decline(attemptId: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const attempt = await readAttempt(tx, attemptId);
      if (attempt.state === 'simulated') return false;
      const ledger = await tx.query('SELECT payment_id FROM mock_payment_ledger WHERE idempotency_key=$1', [attempt.mockPaymentKey]);
      if (ledger.rows.length) return false; // Never release inventory after an effect exists.
      const released = await tx.query<{ variant_id: string; quantity: number }>("UPDATE inventory_reservations SET state='released' WHERE attempt_id=$1 AND state='reserved' RETURNING variant_id,quantity", [attemptId]);
      for (const row of released.rows) await tx.query('UPDATE catalog_variants SET stock_quantity=stock_quantity+$2 WHERE id=$1', [row.variant_id, row.quantity]);
      await tx.query("UPDATE checkout_attempts SET state='declined' WHERE attempt_id=$1", [attemptId]);
      return true;
    });
  }
  async uncertain(attemptId: string): Promise<void> {
    await this.db.query("UPDATE checkout_attempts SET state='uncertain' WHERE attempt_id=$1 AND state='reserved'", [attemptId]);
  }
}

export interface CheckoutTestHooks {
  afterReserve?: (attempt: StoredAttempt) => Promise<void>;
  beforePayment?: () => Promise<void>;
  afterPayment?: () => Promise<void>;
}
/** Explicit test hooks are not controlled by request bodies or environment variables. */
export class DurableCheckoutService {
  constructor(private readonly store: DurableStore, private readonly testHooks: CheckoutTestHooks = {}) {
    if (store.mode !== 'mock-only') throw new Error('Only durable mock payments are permitted');
  }
  getCatalog(): Promise<Catalog> { return this.store.getCatalog(); }
  async quote(input: unknown): Promise<DemoQuote> {
    return { ...quoteCart(await this.store.getCatalog(), parseCartRequest(input)), demoSessionId: await this.store.getSessionId() };
  }
  async checkout(input: unknown): Promise<DemoReceipt> {
    const attempt = await this.store.reserve(parseCheckoutRequest(input));
    if (attempt.receipt) return structuredClone(attempt.receipt);
    if (attempt.state === 'declined') throw new CheckoutError('MOCK_DECLINED', 'This mocked checkout was declined.', 402);
    await this.testHooks.afterReserve?.(attempt);
    try {
      await this.testHooks.beforePayment?.();
      const payment = await this.store.simulatePayment(attempt.attemptId);
      await this.testHooks.afterPayment?.();
      return await this.store.finish(attempt.attemptId, payment);
    } catch (error) {
      if (error instanceof CheckoutError && error.code === 'MOCK_DECLINED') throw error;
      if (error instanceof MockDecline && await this.store.decline(attempt.attemptId)) throw new CheckoutError('MOCK_DECLINED', 'Mock payment declined; demo stock released.', 402);
      await this.store.uncertain(attempt.attemptId);
      throw new CheckoutError('CHECKOUT_UNCERTAIN', 'Retry the same durable demo attempt to reconcile its mock ledger. Do not create another payment attempt.', 503);
    }
  }
}
