const { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base } = require('viem/chains');

const USER_KEY = '0x605c6a2a7eec6c544431e28e22a47e7329b968f7760fb75b5f983ffcd59d17fc';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const CHANNEL_ID = '0xb5eafee4052ebcab3309919498786fd8000178aa34499ba53fa8ff161af13600';

const serverResizeSig = '0xdddcc228546d3540b4ab83a22742772e96dddeb22fa0d870c4141e3dba3b72e65c94aad86d4a3ac5e7d4dd3b51a26f53d326b4fb1af145025d1870b77777f5a31b';

const account = privateKeyToAccount(USER_KEY);
const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({ account, chain: base, transport: http() });

// ABI for getChannelData 
const channelDataAbi = [{
  name: 'getChannelData',
  type: 'function',
  inputs: [{ name: 'channelId', type: 'bytes32' }],
  outputs: [{
    name: '',
    type: 'tuple',
    components: [
      { name: 'stage', type: 'uint8' },
      { name: 'chan', type: 'tuple', components: [
        { name: 'participants', type: 'address[]' },
        { name: 'adjudicator', type: 'address' },
        { name: 'challenge', type: 'uint64' },
        { name: 'nonce', type: 'uint64' },
      ]},
      { name: 'lastValidState', type: 'tuple', components: [
        { name: 'intent', type: 'uint8' },
        { name: 'version', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'allocations', type: 'tuple[]', components: [
          { name: 'destination', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ]},
        { name: 'sigs', type: 'bytes[]' },
      ]},
      { name: 'expectedDeposits', type: 'tuple[]', components: [
        { name: 'destination', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]},
      { name: 'actualDeposits', type: 'tuple[]', components: [
        { name: 'destination', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]},
      { name: 'wallets', type: 'address[]' },
    ],
  }],
  stateMutability: 'view',
}];

// ABI for resize
const resizeAbi = [{
  name: 'resize',
  type: 'function',
  inputs: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'candidate', type: 'tuple', components: [
      { name: 'intent', type: 'uint8' },
      { name: 'version', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'allocations', type: 'tuple[]', components: [
        { name: 'destination', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]},
      { name: 'sigs', type: 'bytes[]' },
    ]},
    { name: 'proofs', type: 'tuple[]', components: [
      { name: 'intent', type: 'uint8' },
      { name: 'version', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'allocations', type: 'tuple[]', components: [
        { name: 'destination', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ]},
      { name: 'sigs', type: 'bytes[]' },
    ]},
  ],
  outputs: [],
  stateMutability: 'nonpayable',
}];

async function main() {
  console.log('User:', account.address);

  // Step 1: Get on-chain channel data (lastValidState for proof)
  console.log('\nFetching on-chain channel data...');
  const channelData = await publicClient.readContract({
    address: CUSTODY_ADDRESS,
    abi: channelDataAbi,
    functionName: 'getChannelData',
    args: [CHANNEL_ID],
  });

  console.log('Channel stage:', channelData.stage);
  console.log('Last valid state version:', channelData.lastValidState.version.toString());
  console.log('Last valid state intent:', channelData.lastValidState.intent);
  console.log('Last valid state sigs count:', channelData.lastValidState.sigs.length);
  console.log('Last valid state allocations:', channelData.lastValidState.allocations.map(a => 
    `${a.destination}: ${a.amount.toString()}`
  ));

  // Step 2: Build candidate (resize state)
  const resizeAllocations = [
    { destination: '0x1E35BAd9b7558Bc2D7DC3A12080010ba04c7A814', token: '0x0000000000000000000000000000000000000000', amount: 100000000000000n },
    { destination: '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a', token: '0x0000000000000000000000000000000000000000', amount: 0n },
  ];
  const resizeData = '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000005af3107a40000000000000000000000000000000000000000000000000000000000000000000';

  // Sign the resize state
  const packedState = encodeAbiParameters(
    parseAbiParameters('bytes32, uint8, uint256, bytes, (address destination, address token, uint256 amount)[]'),
    [CHANNEL_ID, 2, 1n, resizeData, resizeAllocations]
  );
  const stateHash = keccak256(packedState);
  const userSig = await account.sign({ hash: stateHash });
  console.log('\nUser resize sig:', userSig);

  const candidate = {
    intent: 2,
    version: 1n,
    data: resizeData,
    allocations: resizeAllocations,
    sigs: [userSig, serverResizeSig],
  };

  // Step 3: Use the on-chain lastValidState as proof (this is what Cerebro does!)
  const proof = channelData.lastValidState;
  console.log('\nUsing on-chain lastValidState as proof');
  console.log('Proof sigs count:', proof.sigs.length);

  // Step 4: Submit resize
  console.log('\nSubmitting resize() tx...');
  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: CUSTODY_ADDRESS,
      abi: resizeAbi,
      functionName: 'resize',
      args: [CHANNEL_ID, candidate, [proof]],
    });
    console.log('Simulation passed!');
    const hash = await walletClient.writeContract(request);
    console.log('TX hash:', hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('TX status:', receipt.status);
    console.log('Block:', receipt.blockNumber.toString());
    console.log('Gas used:', receipt.gasUsed.toString());
  } catch (e) {
    console.error('TX failed:', e.shortMessage || e.message);
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
