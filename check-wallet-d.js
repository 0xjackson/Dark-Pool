const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const WALLET_D = '0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const sessions = await pool.query(
    `SELECT address, status, created_at, expires_at, jwt_token 
     FROM session_keys 
     WHERE owner = $1 
     ORDER BY created_at DESC`,
    [WALLET_D]
  );
  
  console.log(`\n📍 Wallet D: ${WALLET_D}\n`);
  console.log(`Session Keys: ${sessions.rows.length}\n`);
  
  if (sessions.rows.length === 0) {
    console.log('❌ NO SESSION KEYS\n');
    console.log('Need to:');
    console.log('1. Connect wallet in UI');
    console.log('2. Sign EIP-712 session key authorization\n');
  } else {
    sessions.rows.forEach((s, i) => {
      console.log(`${i+1}. ${s.address.substring(0,10)}...`);
      console.log(`   Status: ${s.status}`);
      console.log(`   Created: ${s.created_at.toISOString()}`);
      console.log(`   Expires: ${s.expires_at.toISOString()}`);
      console.log(`   Has JWT: ${s.jwt_token ? 'Yes' : 'No'}`);
      console.log('');
    });
  }
  
  await pool.end();
}

main();
