const { Pool } = require('./app/server/node_modules/pg');

const DB_URL = process.env.DATABASE_URL;
const USER = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const result = await pool.query(
    `SELECT id, order_id, "user", side, sell_token, buy_token, 
            sell_amount, min_buy_amount, status, created_at
     FROM orders 
     WHERE "user" = $1 
     ORDER BY created_at DESC 
     LIMIT 5`,
    [USER.toLowerCase()]
  );
  
  console.log(`\n📋 Recent orders for ${USER}:\n`);
  
  if (result.rows.length === 0) {
    console.log('   ❌ No orders found\n');
  } else {
    result.rows.forEach(row => {
      const shortId = row.order_id ? row.order_id.substring(0, 16) : 'none';
      console.log(`   ${row.id}. ${shortId}... [${row.status}] ${row.side}`);
      console.log(`      ${row.sell_amount} ${row.sell_token} → min ${row.min_buy_amount} ${row.buy_token}`);
      console.log(`      Created: ${row.created_at}`);
    });
    console.log('');
  }
  
  await pool.end();
}

main();
