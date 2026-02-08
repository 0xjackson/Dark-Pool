// Simulate the create transaction to see why it reverts
const { createPublicClient, http, decodeErrorResult } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');

const CUSTODY = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const USER = '0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791';
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a';
const ADJUDICATOR = '0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C';

async function main() {
  const client = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  console.log('\n🔍 Investigating create() transaction failure...\n');

  // Check 1: Do any channels already exist for this user?
  console.log('1. Checking existing channels on-chain...');
  
  // Note: getOpenChannels doesn't exist on Base, so we can't check this easily
  console.log('   ⚠️  Cannot check (getOpenChannels not available on Base)\n');

  // Check 2: Is the adjudicator address valid?
  console.log('2. Checking adjudicator...');
  console.log(`   Address: ${ADJUDICATOR}`);
  
  try {
    const code = await client.getBytecode({ address: ADJUDICATOR });
    if (code && code !== '0x') {
      console.log('   ✅ Contract exists\n');
    } else {
      console.log('   ❌ NO CONTRACT AT THIS ADDRESS!\n');
    }
  } catch (e) {
    console.log(`   ❌ Error: ${e.message}\n`);
  }

  // Check 3: Try to get more details
  console.log('3. Common failure reasons:');
  console.log('   - Channel with same nonce already exists');
  console.log('   - Invalid signature verification');
  console.log('   - Wrong adjudicator address');
  console.log('   - Participant addresses mismatch');
  console.log('   - State version/intent incorrect\n');

  console.log('💡 To get exact revert reason:');
  console.log('   - Try submitting the tx and check the error');
  console.log('   - Or use cast to simulate: cast call ...\n');
}

main();
