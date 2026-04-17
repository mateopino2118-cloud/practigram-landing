const { Pool } = require('pg');

let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL?.includes('railway') ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000
    });
  }
  return pool;
}

async function query(text, params) {
  const p = getPool();
  if (!p) return null;
  try { return await p.query(text, params); }
  catch (e) { console.error('DB error:', e.message); return null; }
}

module.exports = { query };
