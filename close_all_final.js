const {
  createECDSAMessageSigner,
  createEIP712AuthMessageSigner,
  createAuthRequestMessage,
  createAuthVerifyMessageFromChallenge,
  createCloseChannelMessage,
  createGetChannelsMessageV2,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { createWalletClient, http, encodeAbiParameters } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');
const { privateKeyToAccount, generatePrivateKey } = require('./app/server/node_modules/viem/accounts');
const WebSocket = require('ws');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const PK = 'd6b147b174655503d5393f24aa0ad948e91dcdde6b6f3ae40b82c1980c45154f';

const CUSTODY_ABI = [{
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
        { name: 'allocations', type: 'tuple[]', components: [
          { name: 'destination', type: 'address' },
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ]},
        { name: 'sigs', type: 'bytes[]' },
      ],
    },
  ],
}];

let channelsToClose = [];
let closedCount = 0;

async function main() {
  console.log('\n🧹 Closing all channels with funds...\n');

  const account = privateKeyToAccount(`0x${PK}`);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const ws = new WebSocket(WS_URL);
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  console.log('✅ Connected\n');

  const sessionPk = generatePrivateKey();
  const sessionSigner = createECDSAMessageSigner(sessionPk);
  const sessionAccount = privateKeyToAccount(sessionPk);

  const authParams = {
    session_key: sessionAccount.address,
    allowances: [],
    expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
    scope: 'cleanup',
  };

  const authReqMsg = await createAuthRequestMessage({
    address: account.address,
    application: 'dark-pool',
    ...authParams,
  });

  ws.send(authReqMsg);

  ws.on('message', async (data) => {
    const res = JSON.parse(data.toString());
    const type = res.res?.[1];

    if (type === 'auth_challenge') {
      console.log('🔐 Authenticating...');
      const challenge = res.res[2].challenge_message;
      const signer = createEIP712AuthMessageSigner(walletClient, authParams, { name: 'dark-pool' });
      const verifyMsg = await createAuthVerifyMessageFromChallenge(signer, challenge);
      ws.send(verifyMsg);
    }

    if (type === 'auth_verify') {
      console.log('✅ Authenticated\n');
      console.log('📋 Getting channels...\n');
      ws.send(createGetChannelsMessageV2(account.address));
    }

    if (type === 'get_channels_v2') {
      const channels = res.res[2].channels || [];
      channelsToClose = channels.filter(ch => Number(ch.amount || 0) > 0);

      console.log(`Found ${channelsToClose.length} channels with funds:\n`);
      channelsToClose.forEach(ch => {
        console.log(`  ${ch.channel_id.substring(0,20)}... [${ch.status}] amt=${ch.amount}`);
      });

      if (channelsToClose.length === 0) {
        console.log('\n✅ No channels to close!\n');
        ws.close();
        process.exit(0);
      }

      console.log('\n🔨 Starting closures...\n');

      for (const ch of channelsToClose) {
        const closeMsg = await createCloseChannelMessage(sessionSigner, ch.channel_id, account.address);
        ws.send(closeMsg);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (type === 'close_channel') {
      const { channel_id, state, server_signature } = res.res[2];
      const shortId = channel_id.substring(0, 20);

      try {
        console.log(`📍 ${shortId}...`);

        const packedState = encodeAbiParameters(
          [
            { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'bytes' },
            { type: 'tuple[]', components: [
              { type: 'address' }, { type: 'address' }, { type: 'uint256' }
            ]},
          ],
          [
            channel_id,
            state.intent,
            BigInt(state.version),
            state.state_data || '0x',
            state.allocations.map(a => [a.destination, a.token, BigInt(a.amount)]),
          ]
        );

        const userSig = await walletClient.signMessage({ message: { raw: packedState } });

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
              allocations: state.allocations.map(a => ({
                destination: a.destination,
                token: a.token,
                amount: BigInt(a.amount),
              })),
              sigs: [userSig, server_signature],
            },
          ],
        });

        console.log(`  ✅ Tx: ${txHash}`);
        closedCount++;

        if (closedCount === channelsToClose.length) {
          console.log(`\n✅ All ${closedCount} channels closed!\n`);
          ws.close();
          process.exit(0);
        }
      } catch (e) {
        console.log(`  ❌ ${e.message}`);
      }
    }

    if (type === 'error') {
      console.error('❌', res.res[2]);
    }
  });
}

main();
