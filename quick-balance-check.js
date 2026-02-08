const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createGetLedgerBalancesMessage,
  createECDSAMessageSigner,
} = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = process.env.DATABASE_URL;

async function sendWait(ws, msg, timeoutMs = 15000) {
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
          else resolve({ error: false, params: obj.res[2] });
        }
      } catch {}
    };
    ws.on('message', h);
    ws.send(msg);
  });
}

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const result = await pool.query(
    `SELECT owner, private_key, jwt_token FROM session_keys 
     WHERE owner = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4'
     AND status = 'ACTIVE' ORDER BY created_at DESC LIMIT 1`
  );
  await pool.end();

  if (result.rows.length === 0) {
    console.log('No session key found for 0xA440...');
    return;
  }

  const { owner, private_key, jwt_token } = result.rows[0];

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt_token}` } });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
    setTimeout(() => rej(new Error('timeout')), 10000);
  });

  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  const signer = createECDSAMessageSigner(private_key);
  const msg = await createGetLedgerBalancesMessage(signer, owner);
  const result2 = await sendWait(ws, msg);

  console.log(`\n💰 Unified Balance for ${owner}:`);
  if (result2.error) {
    console.log(`   ❌ ${result2.message}`);
  } else {
    const balances = result2.params?.[0] || [];
    if (balances.length === 0) {
      console.log('   ZERO (no balances)');
    } else {
      balances.forEach(b => {
        console.log(`   ${b.asset.toUpperCase()}: ${b.amount}`);
      });
    }
  }

  ws.close();
}

main().catch(err => console.error('Error:', err.message));
