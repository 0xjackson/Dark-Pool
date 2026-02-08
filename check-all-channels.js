/**
 * Check channel status for all users with session keys
 */
const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createGetChannelsMessageV2,
  parseAnyRPCResponse,
} = require('./app/server/node_modules/@erc7824/nitrolite');
const { getAddress } = require('./app/server/node_modules/viem');

const WS_URL = 'wss://clearnet.yellow.com/ws';
const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:WOpqgAvjmMjRXzgMPmOiRPQtnBMRCQVg@interchange.proxy.rlwy.net:22517/railway';

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

async function checkUserChannels(userAddress, jwt) {
  const addr = getAddress(userAddress);
  const shortAddr = `${addr.substring(0, 6)}...${addr.substring(addr.length - 4)}`;

  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt}` } });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 10000);
  });

  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  const chResult = await sendWait(ws, createGetChannelsMessageV2(addr));
  ws.close();

  if (chResult.error) {
    console.log(`  ${shortAddr}: ❌ ${chResult.message}`);
    return { address: shortAddr, channels: [], error: chResult.message };
  }

  const channels = chResult.params?.channels || [];
  return { address: shortAddr, channels };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Channel Status Check                                  ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const pool = new Pool({ connectionString: DB_URL });

  const result = await pool.query(
    `SELECT DISTINCT ON (owner) owner, jwt_token
     FROM session_keys
     WHERE status = 'ACTIVE' AND expires_at > NOW() AND jwt_token IS NOT NULL
     ORDER BY owner, created_at DESC`
  );

  await pool.end();

  if (result.rows.length === 0) {
    console.log('No users with active session keys found.');
    return;
  }

  console.log(`Checking ${result.rows.length} user(s):\n`);

  let totalChannels = 0;
  let stuckChannels = 0;

  for (const row of result.rows) {
    const { owner, jwt_token } = row;

    try {
      const { address, channels, error } = await checkUserChannels(owner, jwt_token);
      
      if (error) {
        continue;
      }

      totalChannels += channels.length;

      if (channels.length === 0) {
        console.log(`  ${address}: ✅ No channels`);
      } else {
        const stuck = channels.filter(ch => ch.status === 'resizing');
        stuckChannels += stuck.length;

        console.log(`  ${address}: ${channels.length} channel(s)`);
        channels.forEach(ch => {
          const cid = (ch.channel_id || ch.channelId || '').substring(0, 16);
          const status = ch.status || '?';
          const token = ch.token ? ch.token.substring(0, 8) + '...' : '(none)';
          const amount = ch.amount || 0;
          const emoji = status === 'resizing' ? '⚠️ ' : status === 'open' ? '✅' : '  ';
          console.log(`    ${emoji} ${cid}... [${status}] ${token} amt=${amount}`);
        });
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.log(`  ${owner}: ❌ ${err.message}`);
    }
  }

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                               ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Total channels: ${totalChannels}`);
  console.log(`  Stuck (resizing): ${stuckChannels}`);
  console.log(`  Users checked: ${result.rows.length}`);
  
  if (stuckChannels > 0) {
    console.log('\n⚠️  Some channels are stuck in resizing state');
  } else {
    console.log('\n✅ No stuck channels!');
  }
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
