const { createPublicClient, createWalletClient, http, keccak256, encodeAbiParameters } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');
const { privateKeyToAccount, generatePrivateKey } = require('./app/server/node_modules/viem/accounts');
const WebSocket = require('ws');
const {
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessageFromChallenge,
  createCreateChannelMessage,
  createResizeChannelMessage,
  NitroliteClient,
  WalletStateSigner
} = require('./app/server/node_modules/@erc7824/nitrolite');

// Wallet A credentials
const WALLET_A_PK = '0x619aaf81ae957089cf96e6bfeb39d1639b3782d777a1ae51c2683d427f918642';
const WALLET_A_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

// Base mainnet addresses
const CUSTODY = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const ADJUDICATOR = '0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BROKER = '0x435d4B6b68e1083Cc0835D1F971C4739204C1d2a';
const WS_URL = 'wss://clearnet.yellow.com/ws'; // PRODUCTION, not sandbox

console.log('═══════════════════════════════════════════════════════');
console.log('  WALLET A DEPOSIT DEBUG - Base Mainnet');
console.log('═══════════════════════════════════════════════════════\n');

async function main() {
  // Setup viem clients
  const account = privateKeyToAccount(WALLET_A_PK);
  const publicClient = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  });
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  console.log('✓ Clients initialized');
  console.log(`  Wallet: ${account.address}`);
  console.log(`  Chain: Base (${base.id})`);
  console.log(`  Token: USDC (${USDC})\n`);

  // Initialize Nitrolite client for on-chain operations
  const client = new NitroliteClient({
    publicClient,
    walletClient,
    stateSigner: new WalletStateSigner(walletClient),
    addresses: {
      custody: CUSTODY,
      adjudicator: ADJUDICATOR,
    },
    chainId: base.id,
    challengeDuration: 3600n,
  });

  // STEP 1: Check current on-chain custody balance
  console.log('━━━ STEP 1: Check Current Custody Balance ━━━');
  try {
    const balances = await publicClient.readContract({
      address: CUSTODY,
      abi: [{
        type: 'function',
        name: 'getAccountsBalances',
        inputs: [
          { name: 'users', type: 'address[]' },
          { name: 'tokens', type: 'address[]' }
        ],
        outputs: [{ type: 'uint256[]' }],
        stateMutability: 'view'
      }],
      functionName: 'getAccountsBalances',
      args: [[WALLET_A_ADDR], [USDC]],
    });
    console.log(`✓ Current Custody Balance: ${balances[0]} (${Number(balances[0]) / 1e6} USDC)`);
  } catch (e) {
    console.error('✗ Failed to check custody balance:', e.message);
  }
  console.log('');

  // STEP 2: Connect to Clearnode WebSocket
  console.log('━━━ STEP 2: Connect to Clearnode ━━━');
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('✓ WebSocket connected to clearnet.yellow.com');
      resolve();
    });
    ws.on('error', reject);
  });
  console.log('');

  // STEP 3: Generate session key and authenticate
  console.log('━━━ STEP 3: Authenticate with Session Key ━━━');
  const sessionPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const sessionSigner = createECDSAMessageSigner(sessionPrivateKey);

  console.log(`  Session Key Generated: ${sessionAccount.address}`);

  const authParams = {
    session_key: sessionAccount.address,
    allowances: [{ asset: 'usdc', amount: '1000000000' }], // Use 'usdc' symbol, not address
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 86400), // 24 hours
    scope: 'dark-pool',
  };

  const authRequestMsg = await createAuthRequestMessage({
    address: WALLET_A_ADDR,
    application: 'Dark Pool',
    ...authParams
  });

  ws.send(authRequestMsg);
  console.log('✓ Sent auth_request');

  // Wait for auth_challenge
  let authenticated = false;
  ws.on('message', async (data) => {
    const response = JSON.parse(data.toString());
    console.log(`\n[WS] Received: ${response.res?.[1] || 'error'}`);
    console.log(`[WS] Full response:`, JSON.stringify(response, null, 2));

    if (response.res && response.res[1] === 'auth_challenge') {
      console.log('\n━━━ STEP 4: Sign Auth Challenge ━━━');
      const challenge = response.res[2].challenge_message;
      console.log(`  Challenge: ${challenge.substring(0, 50)}...`);

      const signer = createEIP712AuthMessageSigner(
        walletClient,
        authParams,
        { name: 'Dark Pool' }
      );

      const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
      ws.send(verifyMsg);
      console.log('✓ Sent auth_verify with EIP-712 signature\n');
    }

    if (response.res && response.res[1] === 'auth_verify') {
      authenticated = true;
      console.log('✓ AUTHENTICATED');
      console.log(`  Session key: ${response.res[2].session_key}`);
      console.log(`  JWT token: ${response.res[2].jwt ? 'Received' : 'Missing'}\n`);

      // STEP 5: Request channel creation
      console.log('━━━ STEP 5: Request Channel Creation ━━━');
      console.log(`  Token: ${USDC}`);
      console.log(`  Chain: ${base.id}\n`);

      const createChannelMsg = await createCreateChannelMessage(
        sessionSigner,
        {
          chain_id: base.id,
          token: USDC,
        }
      );
      ws.send(createChannelMsg);
      console.log('✓ Sent create_channel request\n');
    }

    if (response.res && response.res[1] === 'create_channel') {
      console.log('━━━ STEP 6: Received Channel Creation Response ━━━');
      const { channel_id, channel, state, server_signature } = response.res[2];

      console.log('Channel Config:');
      console.log(`  ID: ${channel_id}`);
      console.log(`  Participants: ${JSON.stringify(channel.participants)}`);
      console.log(`  Adjudicator: ${channel.adjudicator}`);
      console.log(`  Challenge: ${channel.challenge_duration}`);
      console.log(`  Nonce: ${channel.nonce}\n`);

      console.log('Initial State:');
      console.log(`  Intent: ${state.intent} (should be 1 = INITIALIZE)`);
      console.log(`  Version: ${state.version} (should be 0)`);
      console.log(`  Data: ${state.state_data}`);
      console.log(`  Allocations: ${JSON.stringify(state.allocations, null, 2)}`);
      console.log(`  Server Signature: ${server_signature.substring(0, 20)}...\n`);

      // Verify channel ID computation
      console.log('━━━ STEP 7: Verify Channel ID Computation ━━━');
      const computedChannelId = keccak256(
        encodeAbiParameters(
          [
            { name: 'participants', type: 'address[]' },
            { name: 'adjudicator', type: 'address' },
            { name: 'challenge', type: 'uint64' },
            { name: 'nonce', type: 'uint64' }
          ],
          [
            channel.participants,
            channel.adjudicator,
            BigInt(channel.challenge_duration),
            BigInt(channel.nonce)
          ]
        )
      );
      console.log(`  Computed: ${computedChannelId}`);
      console.log(`  Clearnode: ${channel_id}`);
      console.log(`  Match: ${computedChannelId === channel_id ? '✓ YES' : '✗ NO'}\n`);

      // CRITICAL: Check adjudicator address
      console.log('━━━ STEP 8: Verify Adjudicator Contract ━━━');
      try {
        const code = await publicClient.getBytecode({ address: channel.adjudicator });
        if (code && code !== '0x') {
          console.log(`✓ Adjudicator contract exists at ${channel.adjudicator}`);
          console.log(`  Bytecode length: ${code.length} bytes\n`);
        } else {
          console.error(`✗ NO CONTRACT at adjudicator address ${channel.adjudicator}!`);
          console.error(`  This will cause create() to REVERT!\n`);
          process.exit(1);
        }
      } catch (e) {
        console.error(`✗ Error checking adjudicator:`, e.message, '\n');
        process.exit(1);
      }

      // Transform state for Nitrolite SDK
      const unsignedInitialState = {
        intent: state.intent,
        version: BigInt(state.version),
        data: state.state_data,
        allocations: state.allocations.map(a => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
      };

      console.log('━━━ STEP 9: Simulate create() Transaction ━━━');
      console.log('  Attempting gas estimation...\n');

      try {
        // Try to simulate the transaction first
        const gas = await publicClient.estimateContractGas({
          address: CUSTODY,
          abi: client.custodyAbi, // Use Nitrolite's ABI
          functionName: 'create',
          args: [channel, unsignedInitialState],
          account: WALLET_A_ADDR,
        });
        console.log(`✓ Gas estimation succeeded: ${gas}`);
        console.log(`  This means the transaction SHOULD work!\n`);
      } catch (e) {
        console.error('✗ Gas estimation FAILED:');
        console.error(`  ${e.message}\n`);
        console.error('  This is why MetaMask says "likely to fail"!\n');

        // Try to extract revert reason
        if (e.data) {
          console.error('  Revert data:', e.data);
        }

        console.log('\n━━━ DIAGNOSIS ━━━');
        console.log('Possible causes:');
        console.log('1. Channel with this nonce already exists on-chain');
        console.log('2. Invalid signatures (check EIP-191 encoding)');
        console.log('3. Wrong adjudicator address for Base mainnet');
        console.log('4. Participant addresses mismatch');
        console.log('5. Challenge duration not supported\n');

        process.exit(1);
      }

      console.log('━━━ STEP 10: Submit create() On-Chain ━━━');
      console.log('  Calling Custody.create()...\n');

      try {
        const result = await client.createChannel({
          channel,
          unsignedInitialState,
          serverSignature: server_signature,
        });

        const txHash = typeof result === 'string' ? result : result.txHash;
        console.log(`✓ Transaction submitted: ${txHash}`);
        console.log('  Waiting for confirmation...\n');

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`✓ Transaction confirmed in block ${receipt.blockNumber}`);
        console.log(`  Status: ${receipt.status === 'success' ? 'SUCCESS' : 'REVERTED'}\n`);

        if (receipt.status !== 'success') {
          console.error('✗ Transaction REVERTED on-chain!');
          console.error('  Check Base block explorer for revert reason\n');
          process.exit(1);
        }

        // Wait for clearnode to index the channel
        console.log('━━━ STEP 11: Wait for Clearnode Indexing ━━━');
        console.log('  Waiting 5 seconds for clearnode to process Created event...\n');
        await new Promise(r => setTimeout(r, 5000));

        // Now try resize
        console.log('━━━ STEP 12: Request Resize (Fund Channel) ━━━');
        const resizeAmount = 5000n; // 0.005 USDC (6 decimals)
        console.log(`  Amount: ${resizeAmount} (${Number(resizeAmount) / 1e6} USDC)`);
        console.log(`  Using ONLY allocate_amount (NOT resize_amount)\n`);

        const resizeMsg = await createResizeChannelMessage(
          sessionSigner,
          {
            channel_id: channel_id,
            allocate_amount: resizeAmount,
            funds_destination: WALLET_A_ADDR,
          }
        );
        ws.send(resizeMsg);
        console.log('✓ Sent resize_channel request\n');

      } catch (e) {
        console.error('✗ create() transaction FAILED:');
        console.error(`  ${e.message}\n`);
        process.exit(1);
      }
    }

    if (response.res && response.res[1] === 'resize_channel') {
      console.log('━━━ STEP 13: Received Resize Response ━━━');
      const { channel_id, state, server_signature } = response.res[2];

      console.log('Resize State:');
      console.log(`  Intent: ${state.intent} (should be 2 = RESIZE)`);
      console.log(`  Version: ${state.version}`);
      console.log(`  Allocations: ${JSON.stringify(state.allocations, null, 2)}\n`);

      const resizeState = {
        intent: state.intent,
        version: BigInt(state.version),
        data: state.state_data || state.data,
        allocations: state.allocations.map(a => ({
          destination: a.destination,
          token: a.token,
          amount: BigInt(a.amount),
        })),
        channelId: channel_id,
        serverSignature: server_signature,
      };

      // Get preceding state proof
      console.log('━━━ STEP 14: Fetch Preceding State ━━━');
      try {
        const onChainData = await client.getChannelData(channel_id);
        console.log('✓ Fetched on-chain channel data');
        console.log(`  Status: ${onChainData.status}`);
        console.log(`  Last valid state version: ${onChainData.lastValidState.version}\n`);

        console.log('━━━ STEP 15: Submit resize() On-Chain ━━━');
        const { txHash } = await client.resizeChannel({
          resizeState,
          proofStates: [onChainData.lastValidState],
        });

        console.log(`✓ Resize transaction submitted: ${txHash}`);
        console.log('  Waiting for confirmation...\n');

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`✓ Resize confirmed in block ${receipt.blockNumber}\n`);

        // Check unified balance
        console.log('━━━ STEP 16: Verify Unified Balance Credited ━━━');
        console.log('  Waiting 3 seconds for clearnode to process...\n');
        await new Promise(r => setTimeout(r, 3000));

        // Query via get_ledger_balances
        // (This requires a separate user WS connection - skipping for now)
        console.log('✓ DEPOSIT FLOW COMPLETE');
        console.log('\nNext: Check unified balance via UI or backend API\n');

        process.exit(0);

      } catch (e) {
        console.error('✗ resize() failed:');
        console.error(`  ${e.message}\n`);
        process.exit(1);
      }
    }

    if (response.error) {
      console.error('✗ Clearnode Error:', response.error);
      process.exit(1);
    }
  });
}

main().catch(err => {
  console.error('\n✗ FATAL ERROR:', err);
  process.exit(1);
});
