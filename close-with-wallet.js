const WebSocket = require('ws');
const {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createCloseChannelMessage,
  createECDSAMessageSigner,
  createGetChannelsMessageV2,
  parseAuthChallengeResponse,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');
const { createWalletClient, http, encodeAbiParameters } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
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
}];

function sendWaitRaw(ws, msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = JSON.parse(msg);
    const reqId = parsed.req?.[0];
    const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    const h = (data) => {
      try {
        const obj = JSON.parse(data.toString());
        const rid = obj.res?.[0] ?? obj.err?.[0];
        if (rid === reqId) {
          clearTimeout(t);
          ws.off('message', h);
          resolve(obj);
        }
      } catch {}
    };
    ws.on('message', h);
    ws.send(msg);
  });
}

async function main() {
  const PK = 'd6b147b174655503d5393f24aa0ad948e91dcdde6b6f3ae40b82c1980c45154f';
  const account = privateKeyToAccount(`0x${PK}`);
  
  console.log(`\n🔐 Authenticating ${account.address} with clearnode...\n`);

  const ws = new WebSocket(WS_URL);
  await new Promise((res) => ws.on('open', res));
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  // Step 1: Auth with EIP-712
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 24 * 60 * 60);
  const authParams = {
    address: account.address,
    session_key: account.address,
    application: 'dark-pool',
    allowances: [],
    scope: 'trading',
    expires_at: expiresAt,
  };

  const eip712Signer = createEIP712AuthMessageSigner(
    walletClient,
    { 
      scope: authParams.scope, 
      session_key: authParams.session_key, 
      expires_at: authParams.expires_at, 
      allowances: [] 
    },
    { name: 'clearnode' }
  );

  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendWaitRaw(ws, authReqMsg);
  const challengeParsed = parseAuthChallengeResponse(JSON.stringify(challengeRaw));

  console.log('✅ Got auth challenge');

  const verifyMsg = await createAuthVerifyMessage(eip712Signer, challengeParsed);
  const verifyRaw = await sendWaitRaw(ws, verifyMsg);

  if (verifyRaw.res?.[1] !== 'auth_verify') {
    console.log('❌ Auth failed:', verifyRaw);
    ws.close();
    process.exit(1);
  }

  console.log('✅ Authenticated!\n');

  // Step 2: Get channels
  const chMsg = createGetChannelsMessageV2(account.address);
  const chRaw = await sendWaitRaw(ws, chMsg);
  const channels = chRaw.res[2].channels.filter(ch => Number(ch.amount || 0) > 0);

  console.log(`Found ${channels.length} channels with funds:\n`);
  channels.forEach(ch => {
    console.log(`  ${ch.channel_id.substring(0,20)}... [${ch.status}] amt=${ch.amount}`);
  });
  console.log('');

  // Step 3: Close each channel
  const msgSigner = createECDSAMessageSigner(`0x${PK}`);
  let closed = 0;

  for (const ch of channels) {
    const cid = ch.channel_id;
    const shortId = cid.substring(0, 20);

    try {
      console.log(`📍 Closing ${shortId}...`);
      
      const closeMsg = await createCloseChannelMessage(msgSigner, cid, account.address);
      const closeRaw = await sendWaitRaw(ws, closeMsg);

      if (closeRaw.res?.[1] === 'error') {
        console.log(`   ❌ ${closeRaw.res[2].error}`);
        continue;
      }

      const { state, server_signature } = closeRaw.res[2];
      console.log(`   ✅ Got final state (v${state.version})`);

      const packedState = encodeAbiParameters(
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
          cid,
          state.intent,
          BigInt(state.version),
          state.state_data || '0x',
          state.allocations.map(a => [a.destination, a.token, BigInt(a.amount)]),
        ]
      );

      const userSig = await walletClient.signMessage({ message: { raw: packedState } });
      console.log(`   ✅ Signed`);

      const txHash = await walletClient.writeContract({
        address: CUSTODY_ADDRESS,
        abi: CUSTODY_ABI,
        functionName: 'close',
        args: [
          cid,
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

      console.log(`   ✅ Tx: ${txHash}\n`);
      closed++;

    } catch (err) {
      console.log(`   ❌ ${err.message}\n`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  ws.close();

  console.log(`\n✅ Submitted ${closed}/${channels.length} channel closures!`);
  console.log('⏳ Wait ~30s for confirmations\n');
}

main().catch(err => console.error('Error:', err.message));
