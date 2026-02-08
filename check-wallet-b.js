const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const WALLET_B = '0x1012f3e86C6D71426502b9D0Ba330b04B76ffa5e';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const sk = await pool.query(
    `SELECT address, status, created_at FROM session_keys 
     WHERE owner = $1 ORDER BY created_at DESC LIMIT 1`,
    [WALLET_B]
  );
  
  console.log(`\n📍 Wallet B: ${WALLET_B}\n`);
  
  if (sk.rows.length === 0) {
    console.log('❌ NO SESSION KEY - Must connect wallet in UI first!\n');
  } else {
    console.log(`✅ Session key: ${sk.rows[0].status}`);
    console.log(`   Created: ${sk.rows[0].created_at}\n`);
  }
  
  await pool.end();
}

main();
