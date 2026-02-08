/**
 * Quick script to connect to Yellow clearnode and check unified (ledger) balances.
 * Uses EIP-712 auth (same as the backend's authenticateWs).
 */
const WebSocket = require('ws');
const {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createGetLedgerBalancesMessage,
  parseAuthChallengeResponse,
  RPCMethod,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');
const { createWalletClient, http } = require('./app/server/node_modules/viem');
const { mainnet } = require('./app/server/node_modules/viem/chains');

const ENGINE_KEY = '0x331e79c9badeb68d5c15b1ddf44df8d0f3932230140c81a3757b7e377d822149';
const WS_URL = 'wss://clearnet.yellow.com/ws';
const USER_ADDRESS = '0x9b01fbC738FB48d02Be276c1d53DF590864c170D';

const account = privateKeyToAccount(ENGINE_KEY);
console.log('Engine address:', account.address);

function parseRaw(data) {
  const obj = JSON.parse(data);
  if (obj.res) return { method: obj.res[1], params: obj.res[2], requestId: obj.res[0], raw: obj };
  if (obj.req) return { method: obj.req[1], params: obj.req[2], requestId: obj.req[0], raw: obj };
  return { method: 'unknown', params: obj, raw: obj };
}

function sendAndWait(ws, msg, expectedMethod, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout: ${expectedMethod}`)); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      const p = parseRaw(str);
      if (p.method !== expectedMethod) return; // skip unsolicited
      clearTimeout(timeout);
      ws.off('message', handler);
      resolve(str);
    };
    ws.on('message', handler);
    ws.send(msg);
  });
}

function sendAndWaitResponse(ws, msg, expectedMethod, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error('Timeout')); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      const p = parseRaw(str);
      console.log(`   [ws] method=${p.method}, keys=${Object.keys(p.params||{}).join(',')}`);
      if (expectedMethod && p.method === expectedMethod) {
        clearTimeout(timeout); ws.off('message', handler); resolve(p); return;
      }
      if (!expectedMethod && !['assets', 'pong', 'channels_update', 'balance_update', 'channel_update'].includes(p.method)) {
        clearTimeout(timeout); ws.off('message', handler); resolve(p); return;
      }
    };
    ws.on('message', handler);
    ws.send(msg);
  });
}

async function main() {
  console.log('Connecting to', WS_URL);
  const ws = new WebSocket(WS_URL);
  const initMsgs = [];
  ws.on('message', (d) => initMsgs.push(parseRaw(d.toString()).method));
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  console.log('Connected.');
  await new Promise((r) => setTimeout(r, 1500));
  ws.removeAllListeners('message');
  if (initMsgs.length) console.log('Initial:', initMsgs.join(', '));

  // Auth — EIP-712 (same as backend authenticateWs)
  const walletClient = createWalletClient({ account, chain: mainnet, transport: http() });
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
  const skAddress = account.address;

  const authParams = {
    address: skAddress,
    session_key: skAddress,
    application: 'clearnode',
    allowances: [],
    scope: 'console',
    expires_at: expiresAt,
  };

  const eip712Signer = createEIP712AuthMessageSigner(
    walletClient,
    { scope: authParams.scope, session_key: authParams.session_key, expires_at: authParams.expires_at, allowances: [] },
    { name: 'clearnode' },
  );

  console.log('\n1. auth_request...');
  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWait(ws, authReqMsg, 'auth_challenge');
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);
  console.log('   Got challenge.');

  console.log('2. auth_verify (EIP-712)...');
  const verifyMsg = await createAuthVerifyMessage(eip712Signer, challengeParsed);
  const verifyParsed = await sendAndWaitResponse(ws, verifyMsg, 'auth_verify');
  if (verifyParsed.method === 'error') {
    console.error('   FAILED:', JSON.stringify(verifyParsed.params));
    ws.close();
    return;
  }
  console.log('   Authenticated!');

  // Query balances with ECDSA signer (for signed requests post-auth)
  const msgSigner = createECDSAMessageSigner(ENGINE_KEY);

  console.log(`\n3. get_ledger_balances for ${USER_ADDRESS}...`);
  const balMsg = await createGetLedgerBalancesMessage(msgSigner, USER_ADDRESS);
  const balParsed = await sendAndWaitResponse(ws, balMsg, 'get_ledger_balances');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     USER UNIFIED BALANCE             ║');
  console.log('╚══════════════════════════════════════╝');
  if (balParsed.method === 'error') {
    console.log('  ERROR:', JSON.stringify(balParsed.params));
  } else {
    printBalances(balParsed.params);
  }

  console.log(`\n4. get_ledger_balances for engine ${skAddress}...`);
  const engMsg = await createGetLedgerBalancesMessage(msgSigner, skAddress);
  const engParsed = await sendAndWaitResponse(ws, engMsg, 'get_ledger_balances');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     ENGINE UNIFIED BALANCE           ║');
  console.log('╚══════════════════════════════════════╝');
  if (engParsed.method === 'error') {
    console.log('  ERROR:', JSON.stringify(engParsed.params));
  } else {
    printBalances(engParsed.params);
  }

  // 5. get_channels for user
  console.log(`\n5. get_channels for ${USER_ADDRESS}...`);
  const {
    createGetChannelsMessageV2,
  } = require('./app/server/node_modules/@erc7824/nitrolite');
  const chMsg = createGetChannelsMessageV2(USER_ADDRESS);
  const chParsed = await sendAndWaitResponse(ws, chMsg, 'get_channels');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     USER CHANNELS                    ║');
  console.log('╚══════════════════════════════════════╝');
  if (chParsed.method === 'error') {
    console.log('  ERROR:', JSON.stringify(chParsed.params));
  } else {
    const channels = chParsed.params?.channels || chParsed.params;
    if (Array.isArray(channels) && channels.length > 0) {
      channels.forEach((ch, i) => {
        console.log(`  Channel ${i}:`);
        console.log(`    id:     ${ch.channel_id || ch.channelId}`);
        console.log(`    status: ${ch.status}`);
        console.log(`    token:  ${ch.token}`);
        console.log(`    amount: ${ch.amount}`);
        console.log(`    chain:  ${ch.chain_id || ch.chainId}`);
        console.log(`    ver:    ${ch.version}`);
        if (ch.wallet) console.log(`    wallet: ${ch.wallet}`);
        if (ch.participant) console.log(`    participant: ${ch.participant}`);
      });
    } else {
      console.log('  (no channels)');
      console.log('  Raw:', JSON.stringify(chParsed.params, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    }
  }

  // 6. get_channels for engine too (to see all channels)
  console.log(`\n6. get_channels (all)...`);
  const chAllMsg = createGetChannelsMessageV2();
  const chAllParsed = await sendAndWaitResponse(ws, chAllMsg, 'get_channels');

  console.log('\n╔══════════════════════════════════════╗');
  console.log('║     ALL CHANNELS                     ║');
  console.log('╚══════════════════════════════════════╝');
  if (chAllParsed.method === 'error') {
    console.log('  ERROR:', JSON.stringify(chAllParsed.params));
  } else {
    const channels = chAllParsed.params?.channels || chAllParsed.params;
    if (Array.isArray(channels) && channels.length > 0) {
      channels.forEach((ch, i) => {
        console.log(`  Channel ${i}: id=${(ch.channel_id||ch.channelId||'').substring(0,18)}... status=${ch.status} token=${ch.token} amount=${ch.amount} chain=${ch.chain_id||ch.chainId} ver=${ch.version} wallet=${ch.wallet||''}`);
      });
    } else {
      console.log('  (no channels)');
      console.log('  Raw:', JSON.stringify(chAllParsed.params, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    }
  }

  ws.close();
  console.log('\nDone.');
}

function printBalances(params) {
  let balances = params;
  if (params && params.balances) balances = params.balances;
  if (Array.isArray(balances)) {
    if (balances.length > 0 && Array.isArray(balances[0]) && !balances[0].asset) balances = balances[0];
    if (balances.length === 0) { console.log('  (empty — no balance)'); return; }
    balances.forEach((b) => {
      console.log(`  ${(b.asset || b.token || '?').toUpperCase()}: ${b.amount}`);
    });
  } else {
    console.log('  Raw:', JSON.stringify(params, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  }
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
