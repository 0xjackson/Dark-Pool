/**
 * Script to close stuck "resizing" channels on Yellow Network clearnode.
 *
 * Strategy: authenticate as each user via stored JWT, then sign close_channel
 * with their session key (which IS a registered participant signer).
 *
 * Usage: node close-stuck-channels.js
 */
const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createAuthRequestMessage,
  createAuthVerifyMessageWithJWT,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createCloseChannelMessage,
  createGetChannelsMessageV2,
  createGetLedgerBalancesMessage,
  createAuthVerifyMessage,
  parseAuthChallengeResponse,
  parseAuthVerifyResponse,
  parseAnyRPCResponse,
  RPCMethod,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { privateKeyToAccount } = require('./app/server/node_modules/viem/accounts');
const { createWalletClient, http, getAddress } = require('./app/server/node_modules/viem');
const { mainnet } = require('./app/server/node_modules/viem/chains');

const ENGINE_KEY = '0x331e79c9badeb68d5c15b1ddf44df8d0f3932230140c81a3757b7e377d822149';
const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = 'postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway';

const engineAccount = privateKeyToAccount(ENGINE_KEY);
console.log('Engine address:', engineAccount.address);

function parseRaw(data) {
  const obj = JSON.parse(data);
  if (obj.res) return { method: obj.res[1], params: obj.res[2], requestId: obj.res[0], raw: obj };
  if (obj.req) return { method: obj.req[1], params: obj.req[2], requestId: obj.req[0], raw: obj };
  if (obj.err) return { method: 'error', params: { code: obj.err[1], message: obj.err[2] }, requestId: obj.err[0], raw: obj };
  return { method: 'unknown', params: obj, raw: obj };
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

// Send raw message and wait for response matching reqId
function sendAndWaitById(ws, msg, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = JSON.parse(msg);
    const reqId = parsed.req?.[0];
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout reqId=${reqId}`)); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      try {
        const obj = JSON.parse(str);
        const resId = obj.res?.[0] ?? obj.err?.[0];
        if (resId !== reqId) return;
        clearTimeout(timeout);
        ws.off('message', handler);
        if (obj.err) {
          resolve({ method: 'error', params: { code: obj.err[1], message: obj.err[2] }, raw: obj });
        } else {
          resolve(parseRaw(str));
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(msg);
  });
}

// Send raw message and wait for response by method name
function sendAndWaitByMethod(ws, msg, method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout waiting for ${method}`)); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      try {
        const p = parseRaw(str);
        if (p.method === method || p.method === 'error') {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(p);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(msg);
  });
}

// Send and wait for raw string response by method
function sendAndWaitRaw(ws, msg, method, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.off('message', handler); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      try {
        const obj = JSON.parse(str);
        if ((obj.res && obj.res[1] === method) || obj.err) {
          clearTimeout(timeout);
          ws.off('message', handler);
          resolve(str);
        }
      } catch {}
    };
    ws.on('message', handler);
    ws.send(msg);
  });
}

/**
 * Open a WS and authenticate as a user via their stored JWT.
 */
async function openUserWs(userAddress, sessionKeyAddress, jwt, expiresAt) {
  const ws = await connectWs();
  // drain initial messages
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  // Step 1: auth_request
  const authParams = {
    address: userAddress,
    session_key: sessionKeyAddress,
    application: 'clearnode',
    expires_at: expiresAt,
    scope: 'console',
    allowances: [],
  };

  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWaitRaw(ws, authReqMsg, 'auth_challenge');

  // Step 2: auth_verify with JWT (no signature needed)
  const jwtVerifyMsg = await createAuthVerifyMessageWithJWT(jwt);
  const verifyRaw = await sendAndWaitRaw(ws, jwtVerifyMsg, 'auth_verify');
  const verifyParsed = parseAnyRPCResponse(verifyRaw);

  if (verifyParsed.method === RPCMethod.Error) {
    throw new Error(`User auth failed: ${JSON.stringify(verifyParsed.params)}`);
  }

  console.log(`   Authenticated as ${userAddress.substring(0, 12)}...`);
  return ws;
}

/**
 * Open a WS and authenticate as the engine (for querying).
 */
async function openEngineWs() {
  const ws = await connectWs();
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  const walletClient = createWalletClient({ account: engineAccount, chain: mainnet, transport: http() });
  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);

  const authParams = {
    address: engineAccount.address,
    session_key: engineAccount.address,
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

  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWaitRaw(ws, authReqMsg, 'auth_challenge');
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  const verifyMsg = await createAuthVerifyMessage(eip712Signer, challengeParsed);
  const verifyRaw = await sendAndWaitRaw(ws, verifyMsg, 'auth_verify');
  const verifyParsed = parseAnyRPCResponse(verifyRaw);

  if (verifyParsed.method === RPCMethod.Error) {
    throw new Error(`Engine auth failed: ${JSON.stringify(verifyParsed.params)}`);
  }

  console.log('   Authenticated as engine');
  return ws;
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });

  // Step 1: Load user session keys from DB
  console.log('1. Loading session keys from DB...');
  const skResult = await pool.query(
    `SELECT owner, address, private_key, jwt_token, expires_at
     FROM session_keys
     WHERE status = 'ACTIVE' AND expires_at > NOW() AND owner != 'warlock'
     ORDER BY owner`,
  );

  if (skResult.rows.length === 0) {
    console.log('   No active user session keys found!');
    await pool.end();
    return;
  }

  const userKeys = {};
  for (const row of skResult.rows) {
    const owner = getAddress(row.owner);
    userKeys[owner] = {
      sessionKeyAddress: getAddress(row.address),
      privateKey: row.private_key,
      jwt: row.jwt_token,
      expiresAt: BigInt(Math.floor(new Date(row.expires_at).getTime() / 1000)),
    };
    console.log(`   ${owner.substring(0, 12)}... → session key ${row.address.substring(0, 12)}... jwt=${!!row.jwt_token}`);
  }

  // Step 2: Open engine WS to list all channels
  console.log('\n2. Connecting engine WS...');
  const engineWs = await openEngineWs();
  const engineSigner = createECDSAMessageSigner(ENGINE_KEY);

  console.log('\n3. Listing ALL channels...');
  const chMsg = createGetChannelsMessageV2();
  const chParsed = await sendAndWaitByMethod(engineWs, chMsg, 'get_channels');

  const channels = chParsed.params?.channels || [];
  console.log(`   Found ${channels.length} channels:`);

  const stuckByUser = {}; // userAddress -> [channel, ...]
  channels.forEach((ch, i) => {
    const id = ch.channel_id || ch.channelId;
    const wallet = ch.wallet || ch.participant || '?';
    const status = ch.status;
    console.log(`   [${i}] ${id?.substring(0, 20)}... status=${status} ver=${ch.version} token=${ch.token} wallet=${wallet?.substring(0, 12)}...`);
    if (status === 'resizing') {
      const addr = getAddress(wallet);
      if (!stuckByUser[addr]) stuckByUser[addr] = [];
      stuckByUser[addr].push(ch);
    }
  });

  const totalStuck = Object.values(stuckByUser).reduce((s, arr) => s + arr.length, 0);
  if (totalStuck === 0) {
    console.log('\n   No stuck resizing channels!');
    engineWs.close();
    await pool.end();
    return;
  }

  console.log(`\n   ${totalStuck} stuck channels across ${Object.keys(stuckByUser).length} wallets`);

  // Step 3: For each user with stuck channels, authenticate and close them
  let totalClosed = 0;
  let totalFailed = 0;

  for (const [userAddr, stuckChannels] of Object.entries(stuckByUser)) {
    const sk = userKeys[userAddr];
    if (!sk) {
      console.log(`\n   SKIP ${userAddr.substring(0, 12)}... — no session key in DB`);
      totalFailed += stuckChannels.length;
      continue;
    }

    if (!sk.jwt) {
      console.log(`\n   SKIP ${userAddr.substring(0, 12)}... — no JWT stored`);
      totalFailed += stuckChannels.length;
      continue;
    }

    console.log(`\n4. Closing ${stuckChannels.length} channels for ${userAddr.substring(0, 12)}...`);

    let userWs;
    try {
      userWs = await openUserWs(userAddr, sk.sessionKeyAddress, sk.jwt, sk.expiresAt);
    } catch (err) {
      console.log(`   Auth failed: ${err.message}`);
      totalFailed += stuckChannels.length;
      continue;
    }

    const userSigner = createECDSAMessageSigner(sk.privateKey);

    for (let i = 0; i < stuckChannels.length; i++) {
      const ch = stuckChannels[i];
      const channelId = ch.channel_id || ch.channelId;
      console.log(`   [${i + 1}/${stuckChannels.length}] Closing ${channelId?.substring(0, 20)}...`);

      try {
        const closeMsg = await createCloseChannelMessage(
          userSigner,
          channelId,
          userAddr, // funds_destination
        );

        const result = await sendAndWaitById(userWs, closeMsg);

        if (result.method === 'error') {
          console.log(`      FAILED: ${result.params?.message || JSON.stringify(result.params)}`);
          totalFailed++;
        } else {
          console.log(`      OK: status=${result.params?.status || JSON.stringify(result.params)}`);
          totalClosed++;
        }
      } catch (err) {
        console.log(`      ERROR: ${err.message}`);
        totalFailed++;
      }

      await new Promise(r => setTimeout(r, 500));
    }

    userWs.close();
  }

  console.log(`\n═══════════════════════════════════════`);
  console.log(`  RESULT: ${totalClosed} closed, ${totalFailed} failed`);
  console.log(`═══════════════════════════════════════`);

  // Step 4: Re-check balances for all users
  console.log('\n5. Re-checking balances...');
  for (const userAddr of Object.keys(userKeys)) {
    const balMsg = await createGetLedgerBalancesMessage(engineSigner, userAddr);
    const balParsed = await sendAndWaitByMethod(engineWs, balMsg, 'get_ledger_balances');
    if (balParsed.method === 'error') {
      console.log(`   ${userAddr.substring(0, 12)}...: ERROR ${balParsed.params?.message}`);
    } else {
      const bals = balParsed.params?.ledger_balances || [];
      if (bals.length > 0) {
        bals.forEach(b => console.log(`   ${userAddr.substring(0, 12)}...: ${(b.asset || '?').toUpperCase()} = ${b.amount}`));
      } else {
        console.log(`   ${userAddr.substring(0, 12)}...: (empty)`);
      }
    }
  }

  // Step 5: Final channel listing
  console.log('\n6. Final channel listing...');
  const chFinal = createGetChannelsMessageV2();
  const chFinalParsed = await sendAndWaitByMethod(engineWs, chFinal, 'get_channels');
  const finalChs = chFinalParsed.params?.channels || [];
  if (finalChs.length > 0) {
    finalChs.forEach((ch, i) => {
      const id = ch.channel_id || ch.channelId;
      const wallet = ch.wallet || ch.participant || '?';
      console.log(`   [${i}] ${id?.substring(0, 20)}... status=${ch.status} ver=${ch.version} token=${ch.token} wallet=${wallet?.substring(0, 12)}...`);
    });
  } else {
    console.log('   (no channels)');
  }

  engineWs.close();
  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal:', err.message, err.stack); process.exit(1); });
