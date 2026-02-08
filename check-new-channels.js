const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createGetChannelsMessageV2,
} = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const NEW_ADDR = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const result = await pool.query(
    `SELECT jwt_token FROM session_keys WHERE owner = $1 AND status = 'ACTIVE' LIMIT 1`,
    [NEW_ADDR]
  );
  await pool.end();

  if (result.rows.length === 0) {
    console.log('No session key found');
    return;
  }

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${result.rows[0].jwt_token}` } });
  await new Promise((res) => ws.on('open', res));
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  ws.send(createGetChannelsMessageV2(NEW_ADDR));
  
  const data = await new Promise((res) => {
    ws.once('message', (d) => res(JSON.parse(d.toString())));
  });

  const channels = data.res[2]?.channels || [];
  
  console.log(`\n📍 Channels for ${NEW_ADDR}:\n`);
  
  if (channels.length === 0) {
    console.log('   ❌ No channels found (deposit may not have completed)\n');
  } else {
    channels.forEach(ch => {
      console.log(`   ${ch.channel_id.substring(0,20)}... [${ch.status}] amt=${ch.amount}`);
    });
    console.log('');
  }

  ws.close();
}

main();
