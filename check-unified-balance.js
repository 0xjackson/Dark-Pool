const { Pool } = require('./app/server/node_modules/pg');
const { getLedgerBalances } = require('./app/server/dist/services/yellowConnection.js');

const DB_URL = process.env.DATABASE_URL;
const USER = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4';

async function main() {
  // Initialize pool (yellowConnection uses it)
  global.db = new Pool({ connectionString: DB_URL });
  
  console.log(`\nChecking unified balance for ${USER}...\n`);
  
  try {
    const balances = await getLedgerBalances(USER);
    
    if (balances.length === 0) {
      console.log('❌ ZERO unified balance\n');
    } else {
      console.log('✅ Unified balances:');
      balances.forEach(b => {
        console.log(`   ${b.asset.toUpperCase()}: ${b.amount}`);
      });
      console.log('');
    }
  } catch (err) {
    console.error('❌ Error:', err.message);
  }
  
  await global.db.end();
}

main();
