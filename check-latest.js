const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const NEW_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  const order = await pool.query(
    `SELECT order_id, order_type, sell_amount, min_buy_amount, status, 
            commitment_hash, commitment_tx, created_at
     FROM orders WHERE user_address = $1 
     ORDER BY created_at DESC LIMIT 1`,
    [NEW_ADDR]
  );
  
  if (order.rows.length === 0) {
    console.log('No orders found');
    await pool.end();
    return;
  }

  const o = order.rows[0];
  const shortId = o.order_id.substring(0, 16);

  console.log(`\n📋 Latest Order:\n`);
  console.log(`   ID: ${shortId}...`);
  console.log(`   Type: ${o.order_type}`);
  console.log(`   Status: ${o.status}`);
  console.log(`   Hash: ${o.commitment_hash?.substring(0,20)}...`);
  console.log(`   Tx: ${o.commitment_tx || 'null'}`);
  console.log(`   Created: ${o.created_at.toISOString()}\n`);

  await pool.end();

  // Check on-chain commitment
  const { execSync } = require('child_process');
  try {
    const result = execSync(
      `cast call 0x8CeBfA471cee4FA7b0421A348Ae288a446b0d8BF "commitments(bytes32)" ${o.order_id} --rpc-url https://mainnet.base.org`,
      { encoding: 'utf-8' }
    );
    
    const allZeros = result.trim().match(/^0x0+$/);
    if (allZeros) {
      console.log('❌ NOT committed on-chain\n');
    } else {
      console.log('✅ Committed on-chain!\n');
      console.log(result.substring(0, 200) + '...\n');
    }
  } catch (e) {
    console.log('Error checking on-chain:', e.message);
  }
}

main();
