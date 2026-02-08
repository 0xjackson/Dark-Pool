/**
 * Complete USDC deposit — CORRECT approach:
 * resize_amount ONLY (no allocate_amount).
 *
 * The clearnode's handleResized auto-credits unified balance when DeltaAllocations[0] > 0.
 * Using allocate_amount=-X cancels out the delta to 0, preventing the credit.
 *
 * Usage: USER_PK=<hex> node complete-usdc-deposit.js
 */
const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createAuthRequestMessage,
  createAuthVerifyMessageWithJWT,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createResizeChannelMessage,
  createCreateChannelMessage,
  createCloseChannelMessage,
  createGetChannelsMessageV2,
  createECDSAMessageSigner,
  createGetLedgerBalancesMessage,
  parseAuthChallengeResponse,
  parseAnyRPCResponse,
  RPCMethod,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const {
  privateKeyToAccount,
} = require('./app/server/node_modules/viem/accounts');
const {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  encodeAbiParameters,
  maxUint256,
} = require('./app/server/node_modules/viem');
const { base, mainnet } = require('./app/server/node_modules/viem/chains');

// ── Config ──────────────────────────────────────────────────────────────
const USER_PK = '0x' + (process.env.USER_PK || '');
const ENGINE_KEY = '0x331e79c9badeb68d5c15b1ddf44df8d0f3932230140c81a3757b7e377d822149';
const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = 'postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway';
const RPC_URL = 'https://base-mainnet.g.alchemy.com/v2/LLzk8_r6cCTFwsNzOLJu_';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const CHAIN_ID = 8453;
const DEPOSIT_AMOUNT = BigInt(10000); // 0.01 USDC

const CUSTODY_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'payable', inputs: [{ name: 'account', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [] },
  { name: 'create', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'ch', type: 'tuple', components: [{ name: 'participants', type: 'address[]' }, { name: 'adjudicator', type: 'address' }, { name: 'challenge', type: 'uint64' }, { name: 'nonce', type: 'uint64' }] }, { name: 'initial', type: 'tuple', components: [{ name: 'intent', type: 'uint8' }, { name: 'version', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'allocations', type: 'tuple[]', components: [{ name: 'destination', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] }, { name: 'sigs', type: 'bytes[]' }] }], outputs: [{ name: 'channelId', type: 'bytes32' }] },
  { name: 'resize', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'channelId', type: 'bytes32' }, { name: 'candidate', type: 'tuple', components: [{ name: 'intent', type: 'uint8' }, { name: 'version', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'allocations', type: 'tuple[]', components: [{ name: 'destination', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] }, { name: 'sigs', type: 'bytes[]' }] }, { name: 'proofs', type: 'tuple[]', components: [{ name: 'intent', type: 'uint8' }, { name: 'version', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'allocations', type: 'tuple[]', components: [{ name: 'destination', type: 'address' }, { name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }] }, { name: 'sigs', type: 'bytes[]' }] }], outputs: [] },
  { name: 'getAccountsBalances', type: 'function', stateMutability: 'view', inputs: [{ name: 'accounts', type: 'address[]' }, { name: 'tokens', type: 'address[]' }], outputs: [{ name: '', type: 'uint256[][]' }] },
];
const ERC20_ABI = [
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
];

// ── Helpers ──────────────────────────────────────────────────────────────
function waitForMsg(ws, matchFn, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('WS timeout')); }, timeoutMs);
    const h = (data) => {
      try {
        const obj = JSON.parse(data.toString());
        const r = matchFn(obj);
        if (r !== undefined) { clearTimeout(t); ws.off('message', h); resolve(r); }
      } catch {}
    };
    ws.on('message', h);
  });
}

function sendWait(ws, msg, timeoutMs = 25000) {
  const parsed = JSON.parse(msg);
  const reqId = parsed.req?.[0];
  const p = waitForMsg(ws, (obj) => {
    const rid = obj.res?.[0] ?? obj.err?.[0];
    if (rid === reqId) {
      if (obj.err) return { error: true, code: obj.err[1], message: obj.err[2] };
      return { error: false, method: obj.res[1], params: obj.res[2] };
    }
  }, timeoutMs);
  ws.send(msg);
  return p;
}

function sendWaitRaw(ws, msg, method, timeoutMs = 25000) {
  const p = new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('timeout:' + method)); }, timeoutMs);
    const h = (data) => {
      const str = data.toString();
      try {
        const obj = JSON.parse(str);
        if ((obj.res && obj.res[1] === method) || obj.err) {
          clearTimeout(t); ws.off('message', h); resolve(str);
        }
      } catch {}
    };
    ws.on('message', h);
  });
  ws.send(msg);
  return p;
}

function signChannelState(account, channelId, state) {
  const packedState = encodeAbiParameters(
    [
      { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'bytes' },
      { type: 'tuple[]', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] },
    ],
    [
      channelId,
      state.intent,
      BigInt(state.version),
      state.stateData || state.state_data || state.data || '0x',
      state.allocations.map((a) => [a.destination, a.token, BigInt(a.amount)]),
    ],
  );
  return account.signMessage({ message: { raw: packedState } });
}

async function main() {
  if (USER_PK === '0x' || USER_PK.length < 66) {
    console.error('Usage: USER_PK=<hex> node complete-usdc-deposit.js');
    process.exit(1);
  }

  const userAccount = privateKeyToAccount(USER_PK);
  const USER = userAccount.address;
  console.log('User:', USER);

  const publicClient = createPublicClient({ chain: base, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account: userAccount, chain: base, transport: http(RPC_URL) });
  const pool = new Pool({ connectionString: DB_URL });

  // Load session key
  const skResult = await pool.query(
    `SELECT address, private_key, jwt_token, expires_at FROM session_keys
     WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW() LIMIT 1`,
    [getAddress(USER)],
  );
  if (skResult.rows.length === 0) throw new Error('No active session key');
  const { address: skAddr, private_key: skKey, jwt_token: jwt, expires_at: skExp } = skResult.rows[0];
  const userSigner = createECDSAMessageSigner(skKey);

  // ── Step 1: Check balances ────────────────────────────────────────
  console.log('\n1. On-chain balances...');
  const [custodyBal] = await publicClient.readContract({
    address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'getAccountsBalances',
    args: [[USER], [USDC_ADDRESS]],
  });
  const walletBal = await publicClient.readContract({
    address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [USER],
  });
  console.log(`   Custody USDC: ${custodyBal[0]} (${Number(custodyBal[0]) / 1e6})`);
  console.log(`   Wallet USDC:  ${walletBal} (${Number(walletBal) / 1e6})`);

  // ── Step 2: Deposit USDC to Custody if needed ─────────────────────
  let resizeAmount = custodyBal[0];
  if (resizeAmount === 0n) {
    console.log(`\n2. Depositing ${DEPOSIT_AMOUNT} USDC units to Custody...`);
    const allowance = await publicClient.readContract({
      address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'allowance',
      args: [USER, CUSTODY_ADDRESS],
    });
    if (allowance < DEPOSIT_AMOUNT) {
      console.log('   Approving...');
      const appTx = await walletClient.writeContract({
        address: USDC_ADDRESS, abi: ERC20_ABI, functionName: 'approve',
        args: [CUSTODY_ADDRESS, maxUint256],
      });
      await publicClient.waitForTransactionReceipt({ hash: appTx });
      console.log('   Approved:', appTx);
    }
    const depTx = await walletClient.writeContract({
      address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'deposit',
      args: [USER, USDC_ADDRESS, DEPOSIT_AMOUNT], value: 0n,
    });
    const depRcpt = await publicClient.waitForTransactionReceipt({ hash: depTx });
    console.log('   Deposited:', depTx, 'status:', depRcpt.status);
    resizeAmount = DEPOSIT_AMOUNT;
  } else {
    console.log('\n2. Custody has', resizeAmount.toString(), 'USDC — skipping deposit');
  }

  // ── Step 3: Auth to clearnode ─────────────────────────────────────
  console.log('\n3. Connecting to clearnode...');
  const ws = new WebSocket(WS_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  const authParams = {
    address: getAddress(USER), session_key: getAddress(skAddr),
    application: 'clearnode', expires_at: BigInt(Math.floor(new Date(skExp).getTime() / 1000)),
    scope: 'console', allowances: [],
  };
  await sendWaitRaw(ws, await createAuthRequestMessage(authParams), 'auth_challenge');
  const vrRaw = await sendWaitRaw(ws, await createAuthVerifyMessageWithJWT(jwt), 'auth_verify');
  const vrParsed = parseAnyRPCResponse(vrRaw);
  if (vrParsed.method === RPCMethod.Error) throw new Error('Auth failed');
  console.log('   Authenticated!');

  // ── Step 4: Get or create USDC channel ────────────────────────────
  console.log('\n4. Finding USDC channel...');
  const chResult = await sendWait(ws, createGetChannelsMessageV2(USER));
  const channels = chResult.params?.channels || [];
  // Close ALL existing USDC channels (open or resizing) to start fresh
  const usdcChannels = channels.filter(
    (ch) => ch.token?.toLowerCase() === USDC_ADDRESS.toLowerCase()
  );
  for (const ch of usdcChannels) {
    const sid = ch.channel_id || ch.channelId;
    console.log(`   Closing ${sid.substring(0, 20)}... (status=${ch.status})`);
    await sendWait(ws, await createCloseChannelMessage(userSigner, sid, getAddress(USER)));
    await new Promise(r => setTimeout(r, 500));
  }
  if (usdcChannels.length > 0) {
    console.log(`   Closed ${usdcChannels.length} USDC channel(s). Waiting 3s...`);
    await new Promise(r => setTimeout(r, 3000));
  }

  let initialStateSigs = [];
  let initialStateData = '0x';
  let initialAllocations = [];
  let channelId;

  {
    console.log('   Creating new USDC channel...');
    const createResult = await sendWait(ws, await createCreateChannelMessage(userSigner, {
      chain_id: CHAIN_ID, token: USDC_ADDRESS,
    }));
    if (createResult.error) {
      console.error('   REJECTED:', createResult.message);
      ws.close(); await pool.end(); return;
    }

    const cd = createResult.params;
    channelId = cd.channel_id;
    const createState = cd.state;
    const createServerSig = cd.server_signature;

    console.log('   Channel:', channelId.substring(0, 20) + '...');

    // Sign initial state
    const createSig = await signChannelState(userAccount, channelId, {
      intent: createState.intent, version: createState.version,
      stateData: createState.state_data || '0x', allocations: createState.allocations,
    });

    initialStateSigs = [createSig, createServerSig];
    initialStateData = createState.state_data || '0x';
    initialAllocations = createState.allocations.map((a) => ({
      destination: a.destination, token: a.token, amount: BigInt(a.amount || '0'),
    }));

    // Submit Custody.create() on-chain
    console.log('   Submitting Custody.create()...');
    const createTx = await walletClient.writeContract({
      address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'create',
      args: [
        {
          participants: cd.channel.participants,
          adjudicator: cd.channel.adjudicator,
          challenge: BigInt(cd.channel.challenge || 3600),
          nonce: BigInt(cd.channel.nonce),
        },
        {
          intent: createState.intent, version: BigInt(createState.version),
          data: initialStateData, allocations: initialAllocations, sigs: initialStateSigs,
        },
      ],
    });
    const createRcpt = await publicClient.waitForTransactionReceipt({ hash: createTx });
    console.log('   Created:', createTx, 'status:', createRcpt.status);
    console.log('   Waiting 5s for clearnode...');
    await new Promise(r => setTimeout(r, 5000));
  }

  // ── Step 5: Resize with ONLY resize_amount (THE FIX) ─────────────
  console.log(`\n5. Resize with ONLY resize_amount: +${resizeAmount} (NO allocate_amount)...`);
  console.log('   This is the key fix — allocate_amount cancels out DeltaAllocations to 0.');
  console.log('   resize_amount alone gives DeltaAllocations[0] > 0 → clearnode credits unified balance.');

  const resizeMsg = await createResizeChannelMessage(userSigner, {
    channel_id: channelId,
    resize_amount: resizeAmount,
    // allocate_amount: OMITTED — this is the fix!
    funds_destination: getAddress(USER),
  });
  const resizeResult = await sendWait(ws, resizeMsg);
  if (resizeResult.error) {
    console.error('   REJECTED:', resizeResult.message);
    ws.close(); await pool.end(); return;
  }

  const rs = resizeResult.params.state || resizeResult.params;
  const rsSig = resizeResult.params.server_signature || resizeResult.params.serverSignature;
  const rsData = rs.state_data || rs.stateData || rs.data || '0x';
  console.log('   ACCEPTED! version:', rs.version, 'intent:', rs.intent);
  console.log('   Allocations:', rs.allocations.map((a) => `${a.destination.substring(0, 10)}:${a.amount}`).join(', '));

  // Sign resize state
  console.log('   Signing...');
  const resizeSig = await signChannelState(userAccount, channelId, {
    intent: rs.intent, version: rs.version, stateData: rsData, allocations: rs.allocations,
  });

  // Submit on-chain
  console.log('\n6. Submitting Custody.resize() on-chain...');
  const candidateState = {
    intent: rs.intent, version: BigInt(rs.version), data: rsData,
    allocations: rs.allocations.map((a) => ({
      destination: a.destination, token: a.token, amount: BigInt(a.amount),
    })),
    sigs: [resizeSig, rsSig],
  };

  // Proof state
  const proofState = initialStateSigs.length > 0 ? [{
    intent: 1, version: 0n, data: initialStateData,
    allocations: initialAllocations, sigs: initialStateSigs,
  }] : [];

  try {
    const resizeTx = await walletClient.writeContract({
      address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'resize',
      args: [channelId, candidateState, proofState],
    });
    console.log('   TX:', resizeTx);
    const resizeRcpt = await publicClient.waitForTransactionReceipt({ hash: resizeTx });
    console.log('   Status:', resizeRcpt.status, '| Gas:', resizeRcpt.gasUsed.toString());
  } catch (err) {
    console.error('   FAILED:', err.shortMessage || err.message);
    // Retry with empty proofs
    console.log('   Retrying with empty proofs...');
    try {
      const resizeTx2 = await walletClient.writeContract({
        address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'resize',
        args: [channelId, candidateState, []],
      });
      const r2 = await publicClient.waitForTransactionReceipt({ hash: resizeTx2 });
      console.log('   TX:', resizeTx2, 'Status:', r2.status);
    } catch (err2) {
      console.error('   ALSO FAILED:', err2.shortMessage || err2.message);
      ws.close(); await pool.end(); return;
    }
  }

  // ── Step 7: Check unified balance ─────────────────────────────────
  console.log('\n7. Waiting 10s for clearnode to process Resized event...');
  await new Promise(r => setTimeout(r, 10000));

  // Engine WS for balance check
  const engineAccount = privateKeyToAccount(ENGINE_KEY);
  const engineWC = createWalletClient({ account: engineAccount, chain: mainnet, transport: http() });
  const ws2 = new WebSocket(WS_URL);
  await new Promise((r, j) => { ws2.on('open', r); ws2.on('error', j); });
  await new Promise(r => setTimeout(r, 1000));
  ws2.removeAllListeners('message');

  const eap = {
    address: engineAccount.address, session_key: engineAccount.address,
    application: 'clearnode', allowances: [], scope: 'console',
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 365 * 86400),
  };
  const es = createEIP712AuthMessageSigner(engineWC,
    { scope: eap.scope, session_key: eap.session_key, expires_at: eap.expires_at, allowances: [] },
    { name: 'clearnode' });
  const ecrRaw = await sendWaitRaw(ws2, await createAuthRequestMessage(eap), 'auth_challenge');
  await sendWaitRaw(ws2, await createAuthVerifyMessage(es, parseAuthChallengeResponse(ecrRaw)), 'auth_verify');

  const engineSigner = createECDSAMessageSigner(ENGINE_KEY);
  const balResult = await sendWait(ws2, await createGetLedgerBalancesMessage(engineSigner, USER));

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     UNIFIED BALANCE                  ║');
  console.log('╚══════════════════════════════════════╝');
  if (balResult.error) {
    console.log('  ERROR:', balResult.message);
  } else {
    const bals = balResult.params?.ledger_balances || [];
    if (bals.length > 0) {
      bals.forEach(b => console.log(`  ${(b.asset || '?').toUpperCase()}: ${b.amount}`));
      console.log('\n  *** SUCCESS! Unified balance credited! ***');
    } else {
      console.log('  (still empty — may need more time)');
    }
  }

  // On-chain state
  const [newCustody] = await publicClient.readContract({
    address: CUSTODY_ADDRESS, abi: CUSTODY_ABI, functionName: 'getAccountsBalances',
    args: [[USER], [USDC_ADDRESS]],
  });
  console.log(`\n  Custody USDC: ${newCustody[0]} (was ${custodyBal[0]})`);

  ws.close(); ws2.close(); await pool.end();
  console.log('\nDone.');
}

main().catch((err) => { console.error('\nFatal:', err.message); process.exit(1); });
