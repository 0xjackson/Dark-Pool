/**
 * One-shot script: complete the pending resize to fund unified balance.
 *
 * The resize_channel RPC was already called (server signed the resize state).
 * This script just signs with user wallet + submits Custody.resize() on-chain.
 * Clearnode sees Resized event → credits unified balance.
 */

const { WebSocket } = require('ws');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, createPublicClient, http, keccak256, encodeAbiParameters, parseAbiParameters } = require('viem');
const { base, mainnet } = require('viem/chains');
const {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createGetLedgerBalancesMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
} = require('@erc7824/nitrolite');

// ── Config ──────────────────────────────────────────────────
const USER_KEY = '0x605c6a2a7eec6c544431e28e22a47e7329b968f7760fb75b5f983ffcd59d17fc';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const CHANNEL_ID = '0xb5eafee4052ebcab3309919498786fd8000178aa34499ba53fa8ff161af13600';
const CLEARNODE_URL = 'wss://clearnet.yellow.com/ws';
const BASE_RPC = 'https://mainnet.base.org';
const RESIZE_AMOUNT = 100000000000000n; // 0.0001 ETH

// Server signature from the previous resize_channel RPC (resize is "ongoing" on clearnode)
const SERVER_RESIZE_SIG = '0xdddcc228546d3540b4ab83a22742772e96dddeb22fa0d870c4141e3dba3b72e65c94aad86d4a3ac5e7d4dd3b51a26f53d326b4fb1af145025d1870b77777f5a31b';

const account = privateKeyToAccount(USER_KEY);
const publicClient = createPublicClient({ chain: base, transport: http(BASE_RPC) });
const walletClient = createWalletClient({ account, chain: base, transport: http(BASE_RPC) });

// ── ABIs ────────────────────────────────────────────────────
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

// ── Clearnode auth helpers ──────────────────────────────────
const messageQueue = [];
const waiters = [];

function processMessage(data) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].match(data)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(data);
      return;
    }
  }
  messageQueue.push(data);
}

function waitForMessage(matchFn, timeout = 15000) {
  for (let i = 0; i < messageQueue.length; i++) {
    if (matchFn(messageQueue[i])) return Promise.resolve(messageQueue.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex(w => w.resolve === resolve);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error('Timeout'));
    }, timeout);
    waiters.push({ match: matchFn, resolve, reject, timer });
  });
}

function methodMatch(...methods) {
  return (data) => {
    try {
      const p = JSON.parse(data);
      return p.res && methods.includes(p.res[1]);
    } catch { return false; }
  };
}

// ── Main ────────────────────────────────────────────────────
async function main() {
  console.log('User:', account.address);
  console.log('Resize amount:', RESIZE_AMOUNT.toString(), 'wei');

  // ═══════════════════════════════════════════════════
  // STEP 1: Build resize candidate state
  // ═══════════════════════════════════════════════════
  console.log('\n=== STEP 1: Building resize candidate state ===');

  const resizeAllocations = [
    { destination: '0x1E35BAd9b7558Bc2D7DC3A12080010ba04c7A814', token: '0x0000000000000000000000000000000000000000', amount: RESIZE_AMOUNT },
    { destination: '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a', token: '0x0000000000000000000000000000000000000000', amount: 0n },
  ];

  // state.data = abi.encode(int256[]) with [resize_amount, allocate_amount]
  const resizeData = encodeAbiParameters(
    parseAbiParameters('int256[]'),
    [[BigInt(RESIZE_AMOUNT), 0n]]
  );
  console.log('Resize state data:', resizeData);

  // The contract computes stateHash = keccak256(abi.encode(channelId, intent, version, data, allocations))
  const packedState = encodeAbiParameters(
    parseAbiParameters('bytes32, uint8, uint256, bytes, (address destination, address token, uint256 amount)[]'),
    [CHANNEL_ID, 2, 1n, resizeData, resizeAllocations]  // intent=2 (RESIZE), version=1
  );
  const stateHash = keccak256(packedState);
  console.log('State hash:', stateHash);

  // Sign with user's wallet key (raw ECDSA — contract tries this first)
  const userSig = await account.sign({ hash: stateHash });
  console.log('User signature:', userSig.substring(0, 20) + '...');
  console.log('Server signature:', SERVER_RESIZE_SIG.substring(0, 20) + '...');

  // Build candidate: sigs = [user (CLIENT=0), server (SERVER=1)]
  const candidate = {
    intent: 2,  // RESIZE
    version: 1n,
    data: resizeData,
    allocations: resizeAllocations,
    sigs: [userSig, SERVER_RESIZE_SIG],
  };

  // ═══════════════════════════════════════════════════
  // STEP 2: Build proof (lastValidState from on-chain)
  // Verified from raw getChannelData() hex via cast call.
  // ═══════════════════════════════════════════════════
  console.log('\n=== STEP 2: Using verified on-chain lastValidState as proof ===');

  const proof = {
    intent: 1,  // INITIALIZE
    version: 0n,
    data: '0x',
    allocations: [
      { destination: '0x1E35BAd9b7558Bc2D7DC3A12080010ba04c7A814', token: '0x0000000000000000000000000000000000000000', amount: 0n },
      { destination: '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a', token: '0x0000000000000000000000000000000000000000', amount: 0n },
    ],
    sigs: [
      '0xc771f375e212e0e834e390d229cfce35eca4080d13083b42e4565bdf65dc08fd43b39f55fe06bfab2898f093a911320a41692e2f2c81be782bf9ac0649baa4ad1b',
      '0xe841d062db16edfdfbbe12dedd3ccce0e05400270b8f4862ddeb9d56cf70cfc9436424b3ac69ddea7e82254449cf32a01843474dc04327754376932b147c9a611b',
    ],
  };

  console.log('Proof: intent=1(INIT), version=0, 2 sigs, allocations=[0, 0]');
  console.log('Candidate: intent=2(RESIZE), version=1, 2 sigs, allocations=[0.0001 ETH, 0]');

  // ═══════════════════════════════════════════════════
  // STEP 3: Submit Custody.resize() on-chain
  // ═══════════════════════════════════════════════════
  console.log('\n=== STEP 3: Submitting Custody.resize() ===');

  try {
    console.log('Simulating...');
    const { request } = await publicClient.simulateContract({
      account,
      address: CUSTODY_ADDRESS,
      abi: resizeAbi,
      functionName: 'resize',
      args: [CHANNEL_ID, candidate, [proof]],
    });
    console.log('Simulation PASSED!');

    console.log('Sending transaction...');
    const hash = await walletClient.writeContract(request);
    console.log('TX hash:', hash);

    console.log('Waiting for confirmation...');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log('TX status:', receipt.status);
    console.log('Block:', receipt.blockNumber.toString());
    console.log('Gas used:', receipt.gasUsed.toString());

    if (receipt.status === 'success') {
      console.log('\n*** RESIZE SUCCEEDED ON-CHAIN! ***');
    } else {
      console.error('\n*** TX REVERTED ***');
    }
  } catch (e) {
    console.error('\nTX FAILED:', e.shortMessage || e.message);
    if (e.cause) {
      console.error('Cause:', e.cause.shortMessage || e.cause.message);
    }
  }

  // ═══════════════════════════════════════════════════
  // STEP 4: Check unified balance on clearnode
  // ═══════════════════════════════════════════════════
  console.log('\n=== STEP 4: Checking unified balance on clearnode ===');

  const sessionKeyPrivate = '0x' + require('crypto').randomBytes(32).toString('hex');
  const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);

  const ws = new WebSocket(CLEARNODE_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  ws.on('message', (raw) => processMessage(raw.toString()));

  const authWalletClient = createWalletClient({ account, chain: mainnet, transport: http() });
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const authParams = {
    address: account.address,
    session_key: sessionKeyAccount.address,
    application: 'clearnode',
    expires_at: expiresAt,
    scope: 'console',
    allowances: [{ asset: 'eth', amount: '10' }, { asset: 'usdc', amount: '10000' }],
  };

  ws.send(await createAuthRequestMessage(authParams));
  const challengeRaw = await waitForMessage(methodMatch('auth_challenge'));
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  const eip712Signer = createEIP712AuthMessageSigner(authWalletClient, {
    scope: authParams.scope,
    session_key: authParams.session_key,
    expires_at: authParams.expires_at,
    allowances: authParams.allowances,
  }, { name: authParams.application });

  ws.send(await createAuthVerifyMessage(eip712Signer, challengeParsed));
  const verifyRaw = await waitForMessage(methodMatch('auth_verify', 'error'));
  const verifyParsed = parseAnyRPCResponse(verifyRaw);
  if (verifyParsed.method === 'error') {
    console.error('Auth failed:', verifyParsed.params);
    ws.close();
    process.exit(1);
  }
  console.log('Authenticated to clearnode');

  const signer = createECDSAMessageSigner(sessionKeyPrivate);

  // Wait for clearnode to process the on-chain event
  console.log('Waiting 10s for clearnode to process Resized event...');
  await new Promise(r => setTimeout(r, 10000));

  ws.send(await createGetLedgerBalancesMessage(signer));
  const balRaw = await waitForMessage(methodMatch('get_ledger_balances', 'error'));
  console.log('\nUnified balance:', balRaw);

  ws.close();
  setTimeout(() => process.exit(0), 2000);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
