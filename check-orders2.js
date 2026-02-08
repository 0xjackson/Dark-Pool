const { Pool } = require('./app/server/node_modules/pg');
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  
  // Just get recent orders
  const result = await pool.query(`
    SELECT * FROM orders 
    ORDER BY created_at DESC 
    LIMIT 5
  `);
  
  console.log(`\n📋 Recent orders (${result.rows.length}):\n`);
  
  if (result.rows.length === 0) {
    console.log('   ❌ No orders found\n');
  } else {
    result.rows.forEach(row => {
      console.log(JSON.stringify(row, null, 2));
    });
  }
  
  await pool.end();
}

main();
