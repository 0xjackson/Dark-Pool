const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const { createGetChannelsMessageV2 } = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const WALLET_B = '0x1012f3e86C6D71426502b9D0Ba330b04B76ffa5e';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const sk = await pool.query(
    `SELECT jwt_token FROM session_keys WHERE owner = $1 AND status = 'ACTIVE' LIMIT 1`,
    [WALLET_B]
  );
  await pool.end();

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${sk.rows[0].jwt_token}` } });
  await new Promise((res) => ws.on('open', res));
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  ws.send(createGetChannelsMessageV2(WALLET_B));
  
  const data = await new Promise((res) => {
    ws.once('message', (d) => res(JSON.parse(d.toString())));
  });

  const channels = data.res[2]?.channels || [];
  
  console.log(`\n📍 Channels for Wallet B:\n`);
  
  if (channels.length === 0) {
    console.log('   ❌ No channels (need to create one)\n');
  } else {
    channels.forEach(ch => {
      console.log(`   ${ch.channel_id.substring(0,20)}... [${ch.status}] amt=${ch.amount || 0}`);
    });
    console.log('');
  }

  ws.close();
}

main();
