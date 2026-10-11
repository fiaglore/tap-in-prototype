// Sliding-window rate limits kept in D1 (table rate_events). Simple and portable; for very high
// traffic move these to a Durable Object or the Workers rate limiting binding.

import { nowSec } from './util.js';

// Count recent events in a bucket.
export async function count(db, bucket, windowSec) {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM rate_events WHERE bucket = ?1 AND at > ?2')
    .bind(bucket, nowSec() - windowSec)
    .first();
  return row ? row.n : 0;
}

export async function record(db, bucket) {
  await db.prepare('INSERT INTO rate_events (bucket, at) VALUES (?1, ?2)').bind(bucket, nowSec()).run();
}

// Take one slot: returns false (and records nothing) when the bucket is already full.
export async function take(db, bucket, limit, windowSec) {
  if ((await count(db, bucket, windowSec)) >= limit) return false;
  await record(db, bucket);
  return true;
}

// True when the bucket is full. Used for failure counters: check first, record only on failure.
export async function isFull(db, bucket, limit, windowSec) {
  return (await count(db, bucket, windowSec)) >= limit;
}
