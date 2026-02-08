const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const { createGetChannelsMessageV2 } = require('./app/server/node_modules/@erc7824/nitrolite');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = "postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway";
const WALLET_A = '0x71a1AbDF45228A1b23B9986044aE787d17904413';

console.log('═══════════════════════════════════════════════════════');
console.log('  Wallet A Channel Status Check');
console.log('═══════════════════════════════════════════════════════\n');

async function main() {
  console.log(`Wallet: ${WALLET_A}\n`);

  // Get session key JWT from DB
  console.log('1. Fetching session key from database...');
  const pool = new Pool({ connectionString: DB_URL });
  const sk = await pool.query(
    `SELECT jwt_token, status, expires_at FROM session_keys WHERE owner = $1 ORDER BY created_at DESC LIMIT 1`,
    [WALLET_A]
  );
  await pool.end();

  if (sk.rows.length === 0) {
    console.log('✗ No session key found for Wallet A');
    console.log('   Need to connect wallet in UI and authorize session key first.\n');
    process.exit(1);
  }

  const sessionKey = sk.rows[0];
  console.log(`✓ Session key found`);
  console.log(`  Status: ${sessionKey.status}`);
  console.log(`  Expires: ${sessionKey.expires_at.toISOString()}\n`);

  if (!sessionKey.jwt_token) {
    console.log('✗ Session key has no JWT token (not activated)\n');
    process.exit(1);
  }

  // Connect to clearnode
  console.log('2. Connecting to clearnode...');
  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${sessionKey.jwt_token}` } });
  await new Promise((res) => ws.on('open', res));
  console.log('✓ Connected\n');

  // Wait for initial messages
  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  // Query channels
  console.log('3. Querying channels...');
  ws.send(createGetChannelsMessageV2(WALLET_A));

  const data = await new Promise((res) => {
    ws.once('message', (d) => res(JSON.parse(d.toString())));
  });

  const channels = data.res[2]?.channels || [];

  console.log(`\n📍 Found ${channels.length} channel(s):\n`);

  if (channels.length === 0) {
    console.log('✅ CLEAN SLATE - No channels yet!\n');
    console.log('This means Wallet A can create a fresh channel without conflicts.\n');
  } else {
    channels.forEach((ch, i) => {
      const status = ch.status || 'unknown';
      const amount = ch.amount || '0';
      const token = ch.token || 'unknown';
      const version = ch.version !== undefined ? ch.version : '?';

      console.log(`Channel ${i + 1}:`);
      console.log(`   ID:      ${ch.channel_id.substring(0, 20)}...`);
      console.log(`   Status:  ${status} ${status === 'resizing' ? '⚠️  STUCK' : status === 'open' ? '✓' : ''}`);
      console.log(`   Amount:  ${amount} ${amount === '0' ? '(EMPTY)' : ''}`);
      console.log(`   Token:   ${token}`);
      console.log(`   Version: ${version}`);
      console.log('');
    });

    const stuckChannels = channels.filter(ch => ch.status === 'resizing' && ch.amount === '0');
    if (stuckChannels.length > 0) {
      console.log(`⚠️  WARNING: ${stuckChannels.length} stuck "resizing" channel(s) detected!`);
      console.log('   These will block new deposits. Should close them first.\n');
      console.log('   Run: node close-stuck-channels.js\n');
    }

    const openChannels = channels.filter(ch => ch.status === 'open');
    if (openChannels.length > 0) {
      console.log(`✓ ${openChannels.length} open channel(s) with funds`);
      openChannels.forEach(ch => {
        console.log(`   Token: ${ch.token}, Amount: ${ch.amount}`);
      });
      console.log('');
    }
  }

  ws.close();
}

main().catch(err => {
  console.error('✗ Error:', err.message);
  process.exit(1);
});
