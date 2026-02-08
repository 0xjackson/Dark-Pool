const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const result = await pool.query(`
    SELECT settlement_status, settlement_error, settle_tx_hash, matched_at
    FROM matches 
    ORDER BY matched_at DESC 
    LIMIT 1
  `);
  
  console.log(`\n❌ Match settlement error:\n`);
  if (result.rows.length > 0) {
    const m = result.rows[0];
    console.log(`Status: ${m.settlement_status}`);
    console.log(`Error: ${m.settlement_error || 'none'}`);
    console.log(`Tx: ${m.settle_tx_hash || 'none'}`);
    console.log(`Matched: ${m.matched_at}\n`);
  }
  
  await pool.end();
}

main();
