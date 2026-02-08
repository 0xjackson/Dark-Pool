const { WebSocket } = require('ws');
const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { mainnet } = require('viem/chains');
const {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createGetLedgerBalancesMessage,
  createGetChannelsMessageV2,
  createResizeChannelMessage,
  parseAnyRPCResponse,
  parseAuthChallengeResponse,
} = require('@erc7824/nitrolite');

const USER_KEY = '0x605c6a2a7eec6c544431e28e22a47e7329b968f7760fb75b5f983ffcd59d17fc';
const CLEARNODE_URL = 'wss://clearnet.yellow.com/ws';
const CHANNEL_ID = '0xb5eafee4052ebcab3309919498786fd8000178aa34499ba53fa8ff161af13600';

const userAccount = privateKeyToAccount(USER_KEY);
console.log('User address:', userAccount.address);

const sessionKeyPrivate = '0x' + require('crypto').randomBytes(32).toString('hex');
const sessionKeyAccount = privateKeyToAccount(sessionKeyPrivate);
console.log('Session key:', sessionKeyAccount.address);

const messageQueue = [];
const waiters = [];

function processMessage(data) {
  for (let i = 0; i < waiters.length; i++) {
    if (waiters[i].match(data)) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(data);
      return;
    }
  }
  messageQueue.push(data);
}

function waitForMessage(matchFn, timeout = 10000) {
  for (let i = 0; i < messageQueue.length; i++) {
    if (matchFn(messageQueue[i])) return Promise.resolve(messageQueue.splice(i, 1)[0]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex(w => w.resolve === resolve);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error('Timeout'));
    }, timeout);
    waiters.push({ match: matchFn, resolve, reject, timer });
  });
}

function methodMatch(...methods) {
  return (data) => {
    try {
      const p = JSON.parse(data);
      return p.res && methods.includes(p.res[1]);
    } catch { return false; }
  };
}

async function main() {
  const ws = new WebSocket(CLEARNODE_URL);
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  console.log('Connected to mainnet clearnode');
  ws.on('message', (raw) => processMessage(raw.toString()));

  const walletClient = createWalletClient({
    account: userAccount, chain: mainnet, transport: http(),
  });

  const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const allowances = [{ asset: 'eth', amount: '10' }, { asset: 'usdc', amount: '10000' }];
  const authParams = {
    address: userAccount.address,
    session_key: sessionKeyAccount.address,
    application: 'clearnode',
    expires_at: expiresAt,
    scope: 'console',
    allowances,
  };

  // Auth
  ws.send(await createAuthRequestMessage(authParams));
  const challengeRaw = await waitForMessage(methodMatch('auth_challenge'));
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);
  
  const eip712Signer = createEIP712AuthMessageSigner(walletClient, {
    scope: authParams.scope, session_key: authParams.session_key,
    expires_at: authParams.expires_at, allowances: authParams.allowances,
  }, { name: authParams.application });

  ws.send(await createAuthVerifyMessage(eip712Signer, challengeParsed));
  const verifyRaw = await waitForMessage(methodMatch('auth_verify', 'error'));
  const verifyParsed = parseAnyRPCResponse(verifyRaw);
  if (verifyParsed.method === 'error') {
    console.error('AUTH FAILED:', JSON.stringify(verifyParsed.params));
    process.exit(1);
  }
  console.log('Authenticated!');

  const signer = createECDSAMessageSigner(sessionKeyPrivate);

  // Check balance before
  console.log('\n=== Unified balance BEFORE resize ===');
  ws.send(await createGetLedgerBalancesMessage(signer));
  const bal1 = await waitForMessage(methodMatch('get_ledger_balances', 'error'));
  console.log(bal1);

  // Check channels
  console.log('\n=== Channels ===');
  ws.send(await createGetChannelsMessageV2(userAccount.address));
  const ch = await waitForMessage(methodMatch('get_channels', 'error'));
  console.log(ch);

  // RESIZE with resize_amount (NOT allocate_amount!)
  // resize_amount moves from on-chain custody ledger into channel
  // allocate_amount moves from unified balance into channel
  console.log('\n=== Resize channel with resize_amount ===');
  console.log('Using resize_amount (custody→channel), NOT allocate_amount');
  try {
    ws.send(await createResizeChannelMessage(signer, {
      channel_id: CHANNEL_ID,
      resize_amount: 100000000000000n,  // 0.0001 ETH from custody ledger
      funds_destination: userAccount.address,
    }));
    const resizeResp = await waitForMessage(methodMatch('resize_channel', 'error'), 15000);
    console.log('Resize response:', resizeResp);
  } catch (e) {
    console.error('Resize error:', e.message);
  }

  // Check balance after
  console.log('\n=== Unified balance AFTER resize ===');
  ws.send(await createGetLedgerBalancesMessage(signer));
  const bal2 = await waitForMessage(methodMatch('get_ledger_balances', 'error'));
  console.log(bal2);

  ws.close();
  setTimeout(() => process.exit(0), 1000);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
