const { createWalletClient, http, parseUnits } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');

const WALLET_D_PK = '0xd8b7733ef37e73103814d8a8c062d716928e26f52868f7a9304a157088da2c7d';
const CUSTODY = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ERC20_ABI = [{
  name: 'approve',
  type: 'function',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
}];

const CUSTODY_ABI = [{
  name: 'deposit',
  type: 'function',
  stateMutability: 'payable',
  inputs: [
    { name: 'account', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
}];

async function main() {
  const account = privateKeyToAccount(WALLET_D_PK);
  const client = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const amount = parseUnits('0.005', 6);

  console.log(`\n💰 Depositing for ${account.address}\n`);

  console.log('1. Approving...');
  await client.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [CUSTODY, amount],
  });

  console.log('2. Depositing...');
  const tx = await client.writeContract({
    address: CUSTODY,
    abi: CUSTODY_ABI,
    functionName: 'deposit',
    args: [account.address, USDC, amount],
  });
  
  console.log(`✅ Tx: ${tx}\n`);
}

main();
