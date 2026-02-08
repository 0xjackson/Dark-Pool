const fetch = require('./app/server/node_modules/node-fetch');
const API_BASE = 'https://dark-pool-engine-production.up.railway.app';
const WALLET_B = '0x1012f3e86C6D71426502b9D0Ba330b04B76ffa5e';
const WALLET_B_PK = '0x5d044225bb14328b67a009da90ac5a76b0bab96915677f548918458781c949ad';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main() {
  console.log('\n🔧 Setting up Wallet B Yellow channel...\n');

  // Step 1: Create session key (should already exist from UI connection)
  console.log('1. Checking session key...');
  const balanceCheck = await fetch(`${API_BASE}/api/channel/balances?address=${WALLET_B}`);
  const balData = await balanceCheck.json();
  console.log(`   Current unified balance: ${JSON.stringify(balData.balances)}\n`);

  // Step 2: Create channel
  console.log('2. Requesting channel creation...');
  const createRes = await fetch(`${API_BASE}/api/channel/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userAddress: WALLET_B,
      token: USDC,
      chainId: 8453,
    }),
  });
  
  if (!createRes.ok) {
    console.log(`   ❌ Create failed: ${await createRes.text()}`);
    return;
  }

  const channelInfo = await createRes.json();
  console.log(`   ✅ Channel prepared: ${channelInfo.channelId?.substring(0,20)}...\n`);

  // Step 3: User needs to submit Custody.create() on-chain
  console.log('⚠️  Now you need to:');
  console.log('   1. Connect Wallet B to the UI');
  console.log('   2. The UI will detect the prepared channel');
  console.log('   3. Submit the Custody.create() transaction');
  console.log('   4. Then submit Custody.resize() to credit unified balance\n');
  console.log('OR we can do it all via script...\n');
}

main().catch(err => console.error('Error:', err.message));
