/**
 * Check specific user's channels and balance
 */
const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createGetChannelsMessageV2,
  createGetLedgerBalancesMessage,
  createECDSAMessageSigner,
} = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = process.env.DATABASE_URL;

function waitForMsg(ws, matchFn, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('timeout')); }, timeoutMs);
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

function sendWait(ws, msg, timeoutMs = 15000) {
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

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const result = await pool.query(
    `SELECT owner, private_key, jwt_token FROM session_keys 
     WHERE status = 'ACTIVE' AND expires_at > NOW() AND jwt_token IS NOT NULL 
     ORDER BY created_at DESC LIMIT 1`
  );
  await pool.end();

  if (result.rows.length === 0) {
    console.log('No active session key found');
    return;
  }

  const { owner, private_key, jwt_token } = result.rows[0];
  console.log(`\n📍 User: ${owner}\n`);

  // Connect with JWT
  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt_token}` } });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('timeout')), 10000);
  });
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  // Get channels
  const chResult = await sendWait(ws, createGetChannelsMessageV2(owner));
  if (!chResult.error) {
    const channels = chResult.params?.channels || [];
    console.log(`🔗 Channels (${channels.length}):`);
    if (channels.length === 0) {
      console.log('   (none)');
    } else {
      channels.forEach(ch => {
        const cid = (ch.channel_id || ch.channelId || '').substring(0, 20);
        const status = ch.status || '?';
        const token = ch.token || '(none)';
        const amount = ch.amount || 0;
        console.log(`   ${cid}... [${status}] ${token.substring(0,10)}... amt=${amount}`);
      });
    }
  } else {
    console.log(`❌ get_channels failed: ${chResult.message}`);
  }

  // Get unified balance
  const signer = createECDSAMessageSigner(private_key);
  const balMsg = await createGetLedgerBalancesMessage(signer, owner);
  const balResult = await sendWait(ws, balMsg);
  
  console.log(`\n💰 Unified Balance:`);
  if (!balResult.error) {
    const balances = balResult.params?.[0] || [];
    if (balances.length === 0) {
      console.log('   (none)');
    } else {
      balances.forEach(b => {
        console.log(`   ${b.asset.toUpperCase()}: ${b.amount}`);
      });
    }
  } else {
    console.log(`   ❌ ${balResult.message}`);
  }

  ws.close();
}

main().catch(err => console.error('Error:', err.message));
