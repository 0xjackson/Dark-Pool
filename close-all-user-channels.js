/**
 * Close ALL channels for ALL users with saved session keys.
 * Cleans up stuck resizing channels and lets users start fresh.
 *
 * Usage: node close-all-user-channels.js
 */
const WebSocket = require('ws');
const { Pool } = require('./app/server/node_modules/pg');
const {
  createGetChannelsMessageV2,
  createCloseChannelMessage,
  createECDSAMessageSigner,
  parseAnyRPCResponse,
  RPCMethod,
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

async function closeUserChannels(userAddress, sessionKey, jwt) {
  const addr = getAddress(userAddress);
  console.log(`\n┌─ ${addr.substring(0, 10)}...${addr.substring(addr.length - 8)}`);

  // Connect with user's JWT
  const ws = new WebSocket(WS_URL, { headers: { cookie: `jwt=${jwt}` } });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 10000);
  });

  await new Promise(r => setTimeout(r, 1000));
  ws.removeAllListeners('message');

  console.log('│  Connected via JWT');

  // Get all channels
  const chResult = await sendWait(ws, createGetChannelsMessageV2(addr));
  if (chResult.error) {
    console.log(`│  ❌ get_channels failed: ${chResult.message}`);
    ws.close();
    return { closed: 0, failed: 0 };
  }

  const channels = chResult.params?.channels || [];
  console.log(`│  Found ${channels.length} channel(s)`);

  if (channels.length === 0) {
    ws.close();
    console.log('└─ No channels to close');
    return { closed: 0, failed: 0 };
  }

  const signer = createECDSAMessageSigner(sessionKey);
  let closed = 0;
  let failed = 0;

  for (const ch of channels) {
    const cid = ch.channel_id || ch.channelId;
    const shortId = cid.substring(0, 20);
    const status = ch.status || '?';
    const token = ch.token ? ch.token.substring(0, 10) + '...' : '(none)';

    try {
      const closeMsg = await createCloseChannelMessage(signer, cid, addr);
      const closeResult = await sendWait(ws, closeMsg, 10000);

      if (closeResult.error) {
        console.log(`│  ❌ ${shortId}... (${status}, ${token}) - ${closeResult.message}`);
        failed++;
      } else {
        console.log(`│  ✅ ${shortId}... (${status}, ${token})`);
        closed++;
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (err) {
      console.log(`│  ❌ ${shortId}... - ${err.message}`);
      failed++;
    }
  }

  ws.close();
  console.log(`└─ Result: ${closed} closed, ${failed} failed`);
  return { closed, failed };
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Close All User Channels                               ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  const pool = new Pool({ connectionString: DB_URL });

  // Get all active session keys
  const result = await pool.query(
    `SELECT DISTINCT ON (owner) owner, address, private_key, jwt_token
     FROM session_keys
     WHERE status = 'ACTIVE' AND expires_at > NOW() AND jwt_token IS NOT NULL
     ORDER BY owner, created_at DESC`
  );

  if (result.rows.length === 0) {
    console.log('No users with active session keys found.');
    await pool.end();
    return;
  }

  console.log(`Found ${result.rows.length} user(s) with session keys:\n`);

  let totalClosed = 0;
  let totalFailed = 0;

  for (const row of result.rows) {
    const { owner, address, private_key, jwt_token } = row;

    try {
      const stats = await closeUserChannels(owner, private_key, jwt_token);
      totalClosed += stats.closed;
      totalFailed += stats.failed;
    } catch (err) {
      console.log(`\n❌ ${owner}: ${err.message}`);
      totalFailed++;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  await pool.end();

  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║  SUMMARY                                               ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`  Total closed: ${totalClosed}`);
  console.log(`  Total failed: ${totalFailed}`);
  console.log(`  Users processed: ${result.rows.length}`);
  console.log('\n✅ Done. Users can now create fresh channels via UI.');
}

main().catch((err) => {
  console.error('\n💥 Fatal error:', err.message);
  process.exit(1);
});
