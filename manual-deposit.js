// Manual deposit for Wallet B using its private key
const { createWalletClient, http, parseUnits } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');

const WALLET_B_PK = '0x5d044225bb14328b67a009da90ac5a76b0bab96915677f548918458781c949ad';
const CUSTODY = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
];

const CUSTODY_ABI = [{
  name: 'deposit',
  type: 'function',
  stateMutability: 'payable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [],
}];

async function main() {
  const account = privateKeyToAccount(WALLET_B_PK);
  console.log(`\nDepositing USDC for ${account.address}\n`);

  const client = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const amount = parseUnits('0.005', 6); // 0.005 USDC

  // Step 1: Approve
  console.log('1. Approving USDC...');
  const approveTx = await client.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [CUSTODY, amount],
  });
  console.log(`   Tx: ${approveTx}`);

  // Step 2: Deposit
  console.log('\n2. Depositing to Custody...');
  const depositTx = await client.writeContract({
    address: CUSTODY,
    abi: CUSTODY_ABI,
    functionName: 'deposit',
    args: [account.address, USDC, amount],
  });
  console.log(`   Tx: ${depositTx}\n`);

  console.log('✅ Done! Now use the backend API to create channel + resize.\n');
}

main();
