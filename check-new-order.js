const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const order = await pool.query(
    `SELECT user_address, order_id, order_type, sell_amount, min_buy_amount, 
            status, commitment_hash, created_at
     FROM orders 
     ORDER BY created_at DESC LIMIT 1`
  );
  
  if (order.rows.length === 0) {
    console.log('No orders found');
    await pool.end();
    return;
  }

  const o = order.rows[0];
  console.log(`\n📋 Latest Order:\n`);
  console.log(`   Wallet: ${o.user_address}`);
  console.log(`   Type: ${o.order_type}`);
  console.log(`   Status: ${o.status}`);
  console.log(`   Sell: ${o.sell_amount}`);
  console.log(`   MinBuy: ${o.min_buy_amount}`);
  console.log(`   Created: ${o.created_at.toISOString()}\n`);

  await pool.end();

  // Check on-chain
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      `cast call 0x8CeBfA471cee4FA7b0421A348Ae288a446b0d8BF "commitments(bytes32)" ${o.order_id} --rpc-url https://mainnet.base.org`,
      { encoding: 'utf-8' }
    );
    
    if (result.trim().match(/^0x0+$/)) {
      console.log('❌ NOT committed on-chain\n');
    } else {
      console.log('✅ Committed on-chain!\n');
    }
  } catch (e) {
    console.log('Error checking on-chain:', e.message);
  }
}

main();
