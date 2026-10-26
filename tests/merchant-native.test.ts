import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { initializeEmptyMerchantCatalog } from '../server/src/merchant-catalog-import';
import { validateMerchantDatabaseConnection, assertMerchantDatabaseSchema } from '../db/native-merchant-database';

const values = {
  STARTER_DATASET: 'merchant-catalog-v1',
  SQUARE_SANDBOX_MERCHANT_ID: 'SANDBOXMERCHANT',
  SQUARE_LOCATION_ID: 'SANDBOXLOCATION',
};
test('fresh merchant target must have its own dedicated database and secure URL', () => {
  const url='postgresql://database.railway.internal:5432/fresh_merchant';
  assert.equal(validateMerchantDatabaseConnection({ ...values, MERCHANT_DATABASE_URL:url }).connectionString,url);
  assert.deepEqual(validateMerchantDatabaseConnection({
    ...values,MERCHANT_DATABASE_URL:'postgresql://db.example.net:5432/catalog?sslmode=verify-full',
  }).ssl,{rejectUnauthorized:true});
  for (const candidate of [
    { ...values,MERCHANT_DATABASE_URL:url,DATABASE_URL:url },
    { ...values,MERCHANT_DATABASE_URL:'postgresql://db.example.net:5432/catalog' },
    { ...values,MERCHANT_DATABASE_URL:'postgresql://database.railway.internal:5432/synthetic' },
    { ...values,MERCHANT_DATABASE_URL:url,STARTER_DATASET:'synthetic-retail-v1' },
  ]) assert.throws(()=>validateMerchantDatabaseConnection(candidate));
});
test('merchant schema allowlist rejects a changed location and unexpected existing tables',async()=>{
  const db=await PGlite.create();
  try {
    await initializeEmptyMerchantCatalog(db,{squareMerchantId:values.SQUARE_SANDBOX_MERCHANT_ID,squareLocationId:values.SQUARE_LOCATION_ID});
    await assertMerchantDatabaseSchema(db,values);
    await assert.rejects(assertMerchantDatabaseSchema(db,{...values,SQUARE_LOCATION_ID:'WRONG'}));
    await db.query('CREATE TABLE unexpected_table (id integer PRIMARY KEY)');
    await assert.rejects(assertMerchantDatabaseSchema(db,values),/unrecognized merchant schema/);
  }finally{await db.close();}
});
