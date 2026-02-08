const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const NEW_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const orders = await pool.query(
    `SELECT order_id, order_type, sell_amount, min_buy_amount, status, created_at
     FROM orders WHERE user_address = $1 
     ORDER BY created_at DESC LIMIT 2`,
    [NEW_ADDR]
  );
  
  console.log(`\n📋 Orders for ${NEW_ADDR.substring(0,10)}...:\n`);
  
  if (orders.rows.length === 0) {
    console.log('   ❌ No orders found\n');
  } else {
    orders.rows.forEach(o => {
      const shortId = o.order_id.substring(0, 16);
      console.log(`   ${shortId}... [${o.status}] ${o.order_type}`);
      console.log(`   Sell: ${o.sell_amount}, MinBuy: ${o.min_buy_amount}`);
      console.log(`   Created: ${o.created_at.toISOString()}\n`);
    });
  }
  
  await pool.end();
}

main();
