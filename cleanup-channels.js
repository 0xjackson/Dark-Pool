const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createCloseChannelMessage,
  createECDSAMessageSigner,
  createGetChannelsMessageV2,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');
const { createWalletClient, http, encodeAbiParameters } = require('./app/server/node_modules/viem');
const { base } = require('./app/server/node_modules/viem/chains');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = process.env.DATABASE_URL;
const CUSTODY_ADDRESS = '0x490fb189DdE3a01B00be9BA5F41e3447FbC838b6';
const USER_ADDRESS = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4';

const CUSTODY_ABI = [
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

function sendWait(ws, msg, timeoutMs = 15000) {
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
          if (obj.err) resolve({ error: true, message: obj.err[2] });
          else resolve({ error: false, raw: obj });
        }
      } catch {}
    };
    ws.on('message', h);
    ws.send(msg);
  });
}

async function main() {
  if (!process.env.USER_PK) {
    console.log('Usage: USER_PK=<private_key> node cleanup-channels.js');
    process.exit(1);
  }

  const account = privateKeyToAccount(`0x${process.env.USER_PK.replace('0x', '')}`);
  console.log(`\n🧹 Cleaning up channels for ${account.address}\n`);

  const pool = new Pool({ connectionString: DB_URL });
  const result = await pool.query(
    `SELECT private_key, jwt_token FROM session_keys 
     WHERE owner = $1 AND status = 'ACTIVE' 
     ORDER BY created_at DESC LIMIT 1`,
    [USER_ADDRESS]
  );
  await pool.end();

  if (result.rows.length === 0) {
    console.log('❌ No active session key found');
    process.exit(1);
  }

  const { private_key: sessionKeyPk, jwt_token: jwt } = result.rows[0];

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt}` } });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('timeout')), 10000);
  });
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  console.log('✅ Connected to clearnode\n');

  const chResult = await sendWait(ws, createGetChannelsMessageV2(USER_ADDRESS));
  if (chResult.error) {
    console.log(`❌ Failed to get channels: ${chResult.message}`);
    ws.close();
    process.exit(1);
  }

  const channels = chResult.raw.res[2]?.channels || [];
  const channelsWithFunds = channels.filter(ch => 
    (ch.status === 'open' || ch.status === 'resizing') && Number(ch.amount || 0) > 0
  );

  console.log(`Found ${channels.length} total channels, ${channelsWithFunds.length} with funds:\n`);
  
  if (channelsWithFunds.length === 0) {
    console.log('✅ No channels with funds to clean up!\n');
    ws.close();
    return;
  }

  channelsWithFunds.forEach(ch => {
    const cid = (ch.channel_id || ch.channelId).substring(0, 20);
    console.log(`  ${cid}... [${ch.status}] ${ch.token?.substring(0,10)}... amt=${ch.amount}`);
  });

  console.log('\n⚠️  Closing these channels will move funds to your custody ledger.\n');
  console.log('Proceeding in 3 seconds...\n');
  await new Promise(r => setTimeout(r, 3000));

  const signer = createECDSAMessageSigner(sessionKeyPk);
  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http('https://mainnet.base.org'),
  });

  let closed = 0;
  let failed = 0;

  for (const ch of channelsWithFunds) {
    const cid = ch.channel_id || ch.channelId;
    const shortId = cid.substring(0, 20);

    try {
      console.log(`\n📍 Closing ${shortId}...`);
      
      const closeMsg = await createCloseChannelMessage(signer, cid, USER_ADDRESS);
      const closeResult = await sendWait(ws, closeMsg, 10000);

      if (closeResult.error) {
        console.log(`   ❌ RPC failed: ${closeResult.message}`);
        failed++;
        continue;
      }

      // Parse response: res[2] = {channel_id, state, server_signature}
      const response = closeResult.raw.res[2];
      console.log(`   📦 Response keys: ${Object.keys(response).join(', ')}`);
      
      const state = response.state;
      const serverSig = response.server_signature;
      
      console.log(`   ✅ Got final state (intent=${state.intent}, version=${state.version})`);

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
          state.allocations.map(a => [
            a.destination,
            a.token,
            BigInt(a.amount),
          ]),
        ]
      );

      const userSig = await walletClient.signMessage({ message: { raw: packedState } });
      console.log(`   ✅ Signed final state`);

      console.log(`   📤 Submitting Custody.close()...`);
      const closeTxHash = await walletClient.writeContract({
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
            sigs: [userSig, serverSig],
          },
        ],
      });

      console.log(`   ✅ Submitted: ${closeTxHash}`);
      closed++;

    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      failed++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  ws.close();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                               ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Close transactions submitted: ${closed}`);
  console.log(`  Failed: ${failed}\n`);

  if (closed > 0) {
    console.log('✅ Channels closing! Funds will be in custody ledger.\n');
  }
}

main().catch(err => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
