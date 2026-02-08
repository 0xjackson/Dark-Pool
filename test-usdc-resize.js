/**
 * Test: can we request a resize on the existing open USDC channel for 0xA440?
 * This tests whether stuck resizing channels block resize operations.
 */
const { Pool } = require('./app/server/node_modules/pg');
const WebSocket = require('ws');
const {
  createAuthRequestMessage,
  createAuthVerifyMessageWithJWT,
  createResizeChannelMessage,
  createECDSAMessageSigner,
  parseAnyRPCResponse,
  RPCMethod,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { getAddress } = require('./app/server/node_modules/viem');

const DB_URL = 'postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway';
const WS_URL = 'wss://clearnet.yellow.com/ws';
const USER = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4';
const USDC_CHANNEL = '0x01e70d8a87f77416c5e92168ecfea8922a7579417cf470e313505f21c5db5f4a';

function waitForMsg(ws, matchFn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', handler); reject(new Error('timeout')); }, timeoutMs);
    const handler = (data) => {
      const str = data.toString();
      try {
        const obj = JSON.parse(str);
        const result = matchFn(obj, str);
        if (result !== undefined) {
          clearTimeout(t);
          ws.off('message', handler);
          resolve(result);
        }
      } catch {}
    };
    ws.on('message', handler);
  });
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const sk = await pool.query(
    `SELECT address, private_key, jwt_token, expires_at FROM session_keys
     WHERE owner = $1 AND status = 'ACTIVE' LIMIT 1`,
    [getAddress(USER)],
  );

  if (sk.rows.length === 0) {
    console.log('No session key found');
    await pool.end();
    return;
  }

  const { address: skAddr, private_key: skKey, jwt_token: jwt, expires_at: exp } = sk.rows[0];
  console.log('Session key:', skAddr.substring(0, 14) + '...');

  // Connect and auth via JWT
  const ws = new WebSocket(WS_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  const authParams = {
    address: getAddress(USER),
    session_key: getAddress(skAddr),
    application: 'clearnode',
    expires_at: BigInt(Math.floor(new Date(exp).getTime() / 1000)),
    scope: 'console',
    allowances: [],
  };

  // auth_request
  const arMsg = await createAuthRequestMessage(authParams);
  const challengePromise = waitForMsg(ws, (obj) => {
    if (obj.res && obj.res[1] === 'auth_challenge') return obj;
    if (obj.err) return { error: obj.err[2] };
  });
  ws.send(arMsg);
  const challengeResult = await challengePromise;
  if (challengeResult.error) {
    console.log('Challenge error:', challengeResult.error);
    ws.close(); await pool.end(); return;
  }

  // auth_verify with JWT
  const jwtMsg = await createAuthVerifyMessageWithJWT(jwt);
  const verifyPromise = waitForMsg(ws, (obj) => {
    if (obj.res && obj.res[1] === 'auth_verify') return obj;
    if (obj.err) return { error: obj.err[2] };
  });
  ws.send(jwtMsg);
  const verifyResult = await verifyPromise;
  if (verifyResult.error) {
    console.log('Auth failed:', verifyResult.error);
    ws.close(); await pool.end(); return;
  }
  console.log('Authenticated as', USER.substring(0, 14) + '...');

  // Try resize: small amount (1 USDC = 1000000, try 100 = 0.0001 USDC)
  const signer = createECDSAMessageSigner(skKey);
  const resizeMsg = await createResizeChannelMessage(signer, {
    channel_id: USDC_CHANNEL,
    resize_amount: BigInt(100),      // pull 0.0001 USDC from custody into channel
    allocate_amount: BigInt(-100),   // push from channel to unified balance
    funds_destination: getAddress(USER),
  });

  console.log('\nSending resize_channel for 100 units (0.0001 USDC)...');
  const parsed = JSON.parse(resizeMsg);
  const reqId = parsed.req[0];

  const resizePromise = waitForMsg(ws, (obj) => {
    const rid = obj.res ? obj.res[0] : (obj.err ? obj.err[0] : undefined);
    if (rid === reqId) {
      if (obj.err) return { method: 'error', msg: obj.err[2] };
      return { method: obj.res[1], params: obj.res[2] };
    }
  });
  ws.send(resizeMsg);
  const result = await resizePromise;

  if (result.method === 'error') {
    console.log('RESIZE REJECTED:', result.msg);
  } else {
    console.log('RESIZE ACCEPTED!');
    console.log('State:', JSON.stringify(result.params?.state, null, 2));
    console.log('Server sig:', (result.params?.server_signature || '').substring(0, 20) + '...');
  }

  ws.close();
  await pool.end();
  console.log('\nDone.');
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
