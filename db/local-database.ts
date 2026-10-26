import { PGlite } from '@electric-sql/pglite';
import { mkdir, readFile, readdir, realpath, writeFile, lstat, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrateSyntheticDatabase } from './migrate';
import { DurableCheckoutService, PostgresCheckoutStore } from '../server/src/durable-checkout';

/** Fixed local path only. No connection URLs, credentials, roles, listeners, or production adoption. */
export async function openLocalDemoDatabase() {
  const root = await realpath(resolve('.'));
  const base = resolve(root, '.local-data');
  await mkdir(base, { recursive: true });
  if (await realpath(base) !== base) throw new Error('Refusing redirected local data directory');
  const dataDir = resolve(base, 'checkout-demo');
  const marker = resolve(base, 'checkout-demo.json');
  let marked = false;
  try {
    if (!(await lstat(marker)).isFile()) throw new Error('Invalid local database marker');
    const value = JSON.parse(await readFile(marker, 'utf8'));
    if (value.dataset !== 'synthetic-retail-v1' || value.dataDirectory !== 'checkout-demo') throw new Error('Unknown local database marker');
    marked = true;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const stat = await lstat(dataDir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(dataDir) !== dataDir) throw new Error('Refusing redirected database path');
    if (!marked && (await readdir(dataDir)).length) throw new Error('Refusing to adopt an unmarked database directory');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!marked) await writeFile(marker, JSON.stringify({ dataset: 'synthetic-retail-v1', dataDirectory: 'checkout-demo' }), { flag: 'wx' });
  const ownerPath = resolve(base, 'checkout-demo.owner');
  const ownerText = JSON.stringify({ pid: process.pid, ownerId: randomUUID() });
  let owner;
  try { owner = await open(ownerPath, 'wx'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A local database owner lock exists. Stop the owner first; inspect a stale lock before removing it.'); throw error; }
  await owner.writeFile(ownerText);
  let released = false;
  const releaseOwner = async () => {
    if (released) return; released = true;
    await owner.close();
    if (await readFile(ownerPath, 'utf8') === ownerText) await unlink(ownerPath);
  };
  let db: PGlite;
  try { db = await PGlite.create(dataDir, { relaxedDurability: false }); }
  catch (error) { await releaseOwner(); throw error; }
  try {
    await migrateSyntheticDatabase(db);
    const checkout = new DurableCheckoutService(new PostgresCheckoutStore(db));
    const close = async () => { try { if (!db.closed) await db.close(); } finally { await releaseOwner(); } };
    return { db, checkout, dataDir, close };
  } catch (error) { try { await db.close(); } finally { await releaseOwner(); } throw error; }
}
