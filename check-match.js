const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const NEW_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  // Get latest orders
  const orders = await pool.query(
    `SELECT id, order_id, order_type, status, created_at
     FROM orders WHERE user_address = $1 
     ORDER BY created_at DESC LIMIT 2`,
    [NEW_ADDR]
  );
  
  console.log(`\n📋 Latest Orders:\n`);
  orders.rows.forEach(o => {
    console.log(`   ${o.order_type} [${o.status}] - ${o.created_at.toISOString()}`);
  });
  
  // Check for matches
  if (orders.rows.length >= 2) {
    const matches = await pool.query(
      `SELECT id, settlement_status, matched_at, settlement_error
       FROM matches 
       WHERE buy_order_id = $1 OR sell_order_id = $1
          OR buy_order_id = $2 OR sell_order_id = $2
       ORDER BY matched_at DESC LIMIT 1`,
      [orders.rows[0].id, orders.rows[1].id]
    );
    
    console.log(`\n🔗 Matches:\n`);
    if (matches.rows.length === 0) {
      console.log('   ⏳ No matches yet (orders may still be matching...)\n');
    } else {
      matches.rows.forEach(m => {
        console.log(`   Status: ${m.settlement_status}`);
        console.log(`   Matched: ${m.matched_at?.toISOString()}`);
        if (m.settlement_error) {
          console.log(`   Error: ${m.settlement_error}`);
        }
        console.log('');
      });
    }
  }
  
  await pool.end();
}

main();
