const {
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessageFromChallenge,
  createCloseChannelMessage,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { createPublicClient, createWalletClient, http } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');
const { privateKeyToAccount, generatePrivateKey } = require('./app/server/node_modules/viem/accounts');
const WebSocket = require('ws');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const ADJUDICATOR_ADDRESS = '0x7de4A0736Cf5740fD3Ca2F2e9cc85c9AC223eF0C';
const PRIVATE_KEY = '0xd6b147b174655503d5393f24aa0ad948e91dcdde6b6f3ae40b82c1980c45154f';

const CUSTODY_ABI = [
  {
    name: 'getOpenChannels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'participant', type: 'address' }],
    outputs: [{ name: '', type: 'bytes32[]' }],
  },
  {
    name: 'close',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      {
        name: 'candidate',
        type: 'tuple',
        components: [
          { name: 'intent', type: 'uint8' },
          { name: 'version', type: 'uint256' },
          { name: 'data', type: 'bytes' },
          {
            name: 'allocations',
            type: 'tuple[]',
            components: [
              { name: 'destination', type: 'address' },
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint256' },
            ],
          },
          { name: 'sigs', type: 'bytes[]' },
        ],
      },
    ],
    outputs: [],
  },
];

async function main() {
  console.log('\n🧹 Starting channel cleanup...\n');

  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log(`Wallet: ${account.address}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  // Connect to WebSocket
  const ws = new WebSocket(WS_URL);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  console.log('✅ Connected to clearnode\n');

  // Generate session key for signing messages
  const sessionPrivateKey = generatePrivateKey();
  const sessionSigner = createECDSAMessageSigner(sessionPrivateKey);
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);

  // Authenticate with EIP-712
  const authParams = {
    session_key: sessionAccount.address,
    allowances: [],
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
    scope: 'cleanup',
  };

  const authRequestMsg = await createAuthRequestMessage({
    address: account.address,
    application: 'dark-pool',
    ...authParams,
  });

  ws.send(authRequestMsg);

  ws.on('message', async (data) => {
    const response = JSON.parse(data.toString());

    if (response.res) {
      const type = response.res[1];

      if (type === 'auth_challenge') {
        console.log('📝 Got auth challenge');
        const challenge = response.res[2].challenge_message;
        const signer = createEIP712AuthMessageSigner(
          walletClient,
          authParams,
          { name: 'dark-pool' }
        );
        const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
        ws.send(verifyMsg);
      }

      if (type === 'auth_verify') {
        console.log('✅ Authenticated\n');

        // Get open channels from L1 contract
        console.log('🔍 Fetching open channels from L1...');
        try {
          const openChannelsL1 = await publicClient.readContract({
            address: CUSTODY_ADDRESS,
            abi: CUSTODY_ABI,
            functionName: 'getOpenChannels',
            args: [account.address],
          });

          console.log(`Found ${openChannelsL1.length} open channels on L1\n`);

          if (openChannelsL1.length === 0) {
            console.log('✅ No open channels to close!\n');
            ws.close();
            process.exit(0);
          }

          // Close each channel
          for (const channelId of openChannelsL1) {
            console.log(`📍 Closing ${channelId.substring(0, 20)}...`);

            const closeMsg = await createCloseChannelMessage(
              sessionSigner,
              channelId,
              account.address
            );
            ws.send(closeMsg);

            await new Promise((r) => setTimeout(r, 500));
          }
        } catch (e) {
          console.error('❌ Error fetching L1 channels:', e.message);
          ws.close();
          process.exit(1);
        }
      }

      if (type === 'close_channel') {
        const { channel_id, state, server_signature } = response.res[2];
        console.log(`  ✅ Got final state from clearnode`);

        try {
          console.log(`  📤 Submitting Custody.close() on-chain...`);

          const txHash = await walletClient.writeContract({
            address: CUSTODY_ADDRESS,
            abi: CUSTODY_ABI,
            functionName: 'close',
            args: [
              channel_id,
              {
                intent: state.intent,
                version: BigInt(state.version),
                data: state.state_data || '0x',
                allocations: state.allocations.map((a) => ({
                  destination: a.destination,
                  token: a.token,
                  amount: BigInt(a.amount),
                })),
                sigs: [
                  await walletClient.signMessage({
                    message: {
                      raw: require('./app/server/node_modules/viem').encodeAbiParameters(
                        [
                          { type: 'bytes32' },
                          { type: 'uint8' },
                          { type: 'uint256' },
                          { type: 'bytes' },
                          {
                            type: 'tuple[]',
                            components: [
                              { type: 'address' },
                              { type: 'address' },
                              { type: 'uint256' },
                            ],
                          },
                        ],
                        [
                          channel_id,
                          state.intent,
                          BigInt(state.version),
                          state.state_data || '0x',
                          state.allocations.map((a) => [
                            a.destination,
                            a.token,
                            BigInt(a.amount),
                          ]),
                        ]
                      ),
                    },
                  }),
                  server_signature,
                ],
              },
            ],
          });

          console.log(`  ✅ Closed on-chain: ${txHash}\n`);
        } catch (e) {
          console.error(`  ❌ Failed to close on-chain:`, e.message, '\n');
        }
      }

      if (type === 'error') {
        console.error('❌ Error:', response.res[2]);
      }
    }
  });
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
