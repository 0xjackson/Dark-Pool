const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createCloseChannelMessage,
  createECDSAMessageSigner,
  createGetChannelsMessageV2,
} = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = process.env.DATABASE_URL;
const USER_ADDRESS = '0xA440FCb0B7cAfD0115e8A922b04df0F006B02aC4';

async function main() {
  const pool = new Pool({ connectionString: DB_URL });
  const result = await pool.query(
    `SELECT private_key, jwt_token FROM session_keys 
     WHERE owner = $1 AND status = 'ACTIVE' LIMIT 1`,
    [USER_ADDRESS]
  );
  await pool.end();

  const { private_key, jwt_token } = result.rows[0];

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt_token}` } });
  await new Promise((res) => ws.on('open', res));
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  // Get first channel with funds
  const chMsg = createGetChannelsMessageV2(USER_ADDRESS);
  ws.send(chMsg);
  
  const chData = await new Promise((res) => {
    ws.once('message', (data) => res(JSON.parse(data.toString())));
  });
  
  const channels = chData.res[2].channels.filter(ch => Number(ch.amount || 0) > 0);
  const testChannel = channels[0];
  
  console.log(`\nTesting close_channel on: ${testChannel.channel_id.substring(0,20)}...`);
  console.log(`Status: ${testChannel.status}, Amount: ${testChannel.amount}\n`);

  const signer = createECDSAMessageSigner(private_key);
  const closeMsg = await createCloseChannelMessage(signer, testChannel.channel_id, USER_ADDRESS);
  
  ws.send(closeMsg);
  
  const closeData = await new Promise((res) => {
    ws.once('message', (data) => res(JSON.parse(data.toString())));
  });

  console.log('Response:', JSON.stringify(closeData, null, 2));
  
  ws.close();
}

main();
