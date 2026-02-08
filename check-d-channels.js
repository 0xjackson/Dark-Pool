const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const { createGetChannelsMessageV2 } = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const WALLET_D = '0x2235e67b1b8F0629Dd6737C22AAF0f8bFC5B6791';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const sk = await pool.query(
    `SELECT jwt_token FROM session_keys WHERE owner = $1 AND status = 'ACTIVE' LIMIT 1`,
    [WALLET_D]
  );
  await pool.end();

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${sk.rows[0].jwt_token}` } });
  await new Promise((res) => ws.on('open', res));
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  ws.send(createGetChannelsMessageV2(WALLET_D));
  
  const data = await new Promise((res) => {
    ws.once('message', (d) => res(JSON.parse(d.toString())));
  });

  const channels = data.res[2]?.channels || [];
  
  console.log(`\n📍 Yellow Channels for Wallet D:\n`);
  
  if (channels.length === 0) {
    console.log('✅ CLEAN SLATE - No channels yet!\n');
    console.log('This is good - means no stuck channels.\n');
  } else {
    channels.forEach(ch => {
      console.log(`   ${ch.channel_id.substring(0,20)}... [${ch.status}] amt=${ch.amount || 0}`);
    });
    console.log('');
  }

  ws.close();
}

main();
