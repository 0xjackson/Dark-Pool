const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const matches = await pool.query(
    `SELECT m.id, m.settlement_status, m.matched_at, m.settled_at, 
            m.settlement_error, m.settle_tx_hash,
            bo.user_address as buyer, so.user_address as seller
     FROM matches m
     LEFT JOIN orders bo ON m.buy_order_id = bo.id
     LEFT JOIN orders so ON m.sell_order_id = so.id
     ORDER BY m.matched_at DESC LIMIT 3`
  );
  
  console.log(`\n🔗 Recent Matches:\n`);
  
  matches.rows.forEach((m, i) => {
    console.log(`${i+1}. Match ${m.id.substring(0,8)}...`);
    console.log(`   Buyer: ${m.buyer?.substring(0,10)}...`);
    console.log(`   Seller: ${m.seller?.substring(0,10)}...`);
    console.log(`   Status: ${m.settlement_status}`);
    console.log(`   Matched: ${m.matched_at?.toISOString()}`);
    console.log(`   Settled: ${m.settled_at?.toISOString() || 'pending'}`);
    if (m.settlement_error) {
      console.log(`   Error: ${m.settlement_error.substring(0,100)}...`);
    }
    if (m.settle_tx_hash) {
      console.log(`   Tx: ${m.settle_tx_hash}`);
    }
    console.log('');
  });
  
  await pool.end();
}

main();
