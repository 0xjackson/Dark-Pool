const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const NEW_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  // Check if session key exists
  const sk = await pool.query(
    `SELECT address, status, created_at FROM session_keys 
     WHERE owner = $1 ORDER BY created_at DESC LIMIT 1`,
    [NEW_ADDR]
  );
  
  console.log(`\n📍 New Wallet: ${NEW_ADDR}\n`);
  
  if (sk.rows.length > 0) {
    console.log(`✅ Session key: ${sk.rows[0].address.substring(0,10)}... [${sk.rows[0].status}]`);
  } else {
    console.log(`⚠️  No session key yet (connect wallet in UI first)`);
  }
  
  // Check orders
  const orders = await pool.query(
    `SELECT order_id, order_type, status, created_at 
     FROM orders WHERE user_address = $1 
     ORDER BY created_at DESC LIMIT 3`,
    [NEW_ADDR]
  );
  
  console.log(`📋 Orders: ${orders.rows.length}`);
  orders.rows.forEach(o => {
    console.log(`   ${o.order_type} [${o.status}] - ${o.created_at.toISOString()}`);
  });
  
  await pool.end();
  console.log('');
}

main();
