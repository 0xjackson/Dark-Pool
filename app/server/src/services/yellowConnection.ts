import { WebSocket } from 'ws';
import { Pool } from 'pg';
import { createWalletClient, http, Hex, Address, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createAuthVerifyMessageWithJWT,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createGetAssetsMessageV2,
  createAppSessionMessage,
  createCloseAppSessionMessage,
  createRevokeSessionKeyMessage,
  createPingMessageV2,
  createCreateChannelMessage,
  createResizeChannelMessage,
  createGetChannelsMessageV2,
  createGetLedgerBalancesMessage,
  parseAuthChallengeResponse,
  parseAuthVerifyResponse,
  parseAnyRPCResponse,
  parseGetAssetsResponse,
  parseCreateAppSessionResponse,
  parseCloseAppSessionResponse,
  RPCMethod,
  RPCProtocolVersion,
  AuthRequestParams,
  EIP712AuthTypes,
} from '@erc7824/nitrolite';
import { generateSessionKey } from '../utils/keygen';

const YELLOW_WS_URL = process.env.YELLOW_WS_URL || 'wss://clearnet-sandbox.yellow.com/ws';
const ENGINE_WALLET_KEY = process.env.ENGINE_WALLET_KEY as Hex | undefined;
const CHAIN_ID = process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 8453;
const RESPONSE_TIMEOUT = 10_000;
const PING_INTERVAL_MS = 30_000; // Send ping every 30s to keep WS alive

// Asset map: token address -> Yellow symbol (e.g. "0x1234..." -> "usdc")
let assetMap: Map<string, string> = new Map();

// Engine's persistent WS connection
let engineWs: WebSocket | null = null;
let engineSessionKeyAddress: Address | null = null;
let engineMessageSigner: ReturnType<typeof createECDSAMessageSigner> | null = null;
let enginePingInterval: ReturnType<typeof setInterval> | null = null;

// User WS pool: userAddress -> WebSocket
const userWsPool: Map<string, WebSocket> = new Map();

// Pending response handlers
type ResponseHandler = { resolve: (data: string) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> };
const pendingResponses: Map<number, ResponseHandler> = new Map();

function attachResponseRouter(ws: WebSocket) {
  ws.on('message', (raw: Buffer) => {
    const data = raw.toString();
    try {
      const parsed = JSON.parse(data);
      const reqId = parsed.res?.[0] ?? parsed.req?.[0];
      if (reqId !== undefined && pendingResponses.has(reqId)) {
        const handler = pendingResponses.get(reqId)!;
        clearTimeout(handler.timer);
        pendingResponses.delete(reqId);
        handler.resolve(data);
      }
    } catch {
      // not JSON or no reqId — ignore
    }
  });
}

function sendAndWait(ws: WebSocket, message: string, timeout = RESPONSE_TIMEOUT): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = JSON.parse(message);
    const reqId = parsed.req?.[0];
    if (reqId === undefined) {
      ws.send(message);
      return resolve('');
    }

    const timer = setTimeout(() => {
      pendingResponses.delete(reqId);
      reject(new Error(`Timeout waiting for response (reqId=${reqId})`));
    }, timeout);

    pendingResponses.set(reqId, { resolve, reject, timer });
    ws.send(message);
  });
}

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', (err) => reject(err));
  });
}

async function authenticateWs(
  ws: WebSocket,
  walletKey: Hex,
  sessionKeyAddress: Address,
  application: string,
  expiresAt: bigint,
  allowances: Array<{ asset: string; amount: string }>,
): Promise<void> {
  const walletAccount = privateKeyToAccount(walletKey);
  const walletClient = createWalletClient({
    account: walletAccount,
    chain: mainnet,
    transport: http(),
  });

  const authParams: AuthRequestParams = {
    address: walletAccount.address,
    session_key: sessionKeyAddress,
    application,
    expires_at: expiresAt,
    scope: 'console',
    allowances,
  };

  const eip712Signer = createEIP712AuthMessageSigner(
    walletClient,
    {
      scope: authParams.scope,
      session_key: authParams.session_key,
      expires_at: authParams.expires_at,
      allowances: authParams.allowances,
    },
    { name: authParams.application },
  );

  // Step 1: auth_request
  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWait(ws, authReqMsg);
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  // Step 2: auth_verify
  const authVerifyMsg = await createAuthVerifyMessage(eip712Signer, challengeParsed);
  const verifyRaw = await sendAndWait(ws, authVerifyMsg);
  const verifyParsed = parseAnyRPCResponse(verifyRaw);

  if (verifyParsed.method === RPCMethod.Error) {
    throw new Error(`Auth verify failed: ${JSON.stringify(verifyParsed.params)}`);
  }
}

// ---------------------------------------------------------------------------
// Engine boot
// ---------------------------------------------------------------------------

export async function initEngineConnection(db: Pool): Promise<void> {
  if (!ENGINE_WALLET_KEY) {
    console.warn('ENGINE_WALLET_KEY not set — skipping Yellow Network connection');
    return;
  }

  // Check DB for existing active warlock key
  const existing = await db.query(
    `SELECT address, private_key FROM session_keys
     WHERE owner = 'warlock' AND status = 'ACTIVE' AND expires_at > NOW()
     LIMIT 1`,
  );

  let skAddress: Address;
  let skPrivateKey: Hex;

  if (existing.rows.length > 0) {
    skAddress = existing.rows[0].address as Address;
    skPrivateKey = existing.rows[0].private_key as Hex;
    console.log(`Loaded existing warlock session key: ${skAddress}`);
  } else {
    // Generate new key
    const sk = generateSessionKey();
    skAddress = sk.address;
    skPrivateKey = sk.privateKey;

    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // +1 year

    // Open WS and authenticate BEFORE inserting
    const ws = await connectWs(YELLOW_WS_URL);
    attachResponseRouter(ws);

    await authenticateWs(
      ws,
      ENGINE_WALLET_KEY,
      skAddress,
      'clearnode',
      BigInt(Math.floor(expiresAt.getTime() / 1000)),
      [],
    );

    // Persist
    await db.query(
      `INSERT INTO session_keys (owner, address, private_key, application, status, expires_at)
       VALUES ('warlock', $1, $2, 'clearnode', 'ACTIVE', $3)
       ON CONFLICT (owner, application) DO UPDATE
       SET address = $1, private_key = $2, status = 'ACTIVE', expires_at = $3`,
      [skAddress, skPrivateKey, expiresAt.toISOString()],
    );

    engineWs = ws;
    engineSessionKeyAddress = skAddress;
    engineMessageSigner = createECDSAMessageSigner(skPrivateKey);

    console.log(`Warlock session key registered with Yellow: ${skAddress}`);
  }

  // If we loaded from DB (no WS yet), open and authenticate
  if (!engineWs) {
    engineWs = await connectWs(YELLOW_WS_URL);
    attachResponseRouter(engineWs);

    const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60);
    await authenticateWs(engineWs, ENGINE_WALLET_KEY, skAddress, 'clearnode', expiresAt, []);

    engineSessionKeyAddress = skAddress;
    engineMessageSigner = createECDSAMessageSigner(skPrivateKey);
    console.log(`Re-authenticated warlock session key: ${skAddress}`);
  }

  // Start keepalive pings
  if (enginePingInterval) clearInterval(enginePingInterval);
  enginePingInterval = setInterval(() => {
    if (engineWs && engineWs.readyState === WebSocket.OPEN) {
      const pingMsg = createPingMessageV2();
      engineWs.send(pingMsg);
    }
  }, PING_INTERVAL_MS);

  // Auto-reconnect on close
  engineWs.on('close', () => {
    console.warn('Engine WS closed, reconnecting in 5s...');
    if (enginePingInterval) { clearInterval(enginePingInterval); enginePingInterval = null; }
    engineWs = null;
    setTimeout(() => initEngineConnection(db).catch(console.error), 5000);
  });

  // Load asset map
  await loadAssetMap();
}

// ---------------------------------------------------------------------------
// Asset map
// ---------------------------------------------------------------------------

async function loadAssetMap(): Promise<void> {
  if (!engineWs) return;

  const msg = createGetAssetsMessageV2();
  const raw = await sendAndWait(engineWs, msg);
  const parsed = parseGetAssetsResponse(raw);

  assetMap = new Map();
  if (parsed.params?.assets) {
    for (const asset of parsed.params.assets) {
      // Filter by our chain to avoid cross-chain address collisions
      // (e.g. 0xeeee...eeee is native token on multiple chains with different symbols)
      if (asset.chainId !== CHAIN_ID) continue;
      assetMap.set(asset.token.toLowerCase(), asset.symbol.toLowerCase());
    }
  }

  console.log(`Loaded ${assetMap.size} assets for chain ${CHAIN_ID} from Yellow Network`);
  for (const [addr, sym] of assetMap) {
    console.log(`  ${sym}: ${addr}`);
  }
}

// Common representations of native ETH that should all resolve to the zero address
const NATIVE_ETH_ALIASES = [
  '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  '0x0000000000000000000000000000000000000000',
];

export function getAssetSymbol(tokenAddress: string): string | undefined {
  const addr = tokenAddress.toLowerCase();
  const result = assetMap.get(addr);
  if (result) return result;

  // Normalize native ETH aliases (frontend uses 0xeee..., Yellow uses 0x000...)
  if (NATIVE_ETH_ALIASES.includes(addr)) {
    for (const alias of NATIVE_ETH_ALIASES) {
      const aliasResult = assetMap.get(alias);
      if (aliasResult) return aliasResult;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// User WS pool
// ---------------------------------------------------------------------------

export async function openUserWs(
  userAddress: string,
  walletKey: Hex,
  sessionKeyAddress: Address,
  expiresAt: bigint,
  allowances: Array<{ asset: string; amount: string }>,
): Promise<WebSocket> {
  // Close existing if any
  const existingWs = userWsPool.get(getAddress(userAddress as Address));
  if (existingWs && existingWs.readyState === WebSocket.OPEN) {
    return existingWs;
  }

  const ws = await connectWs(YELLOW_WS_URL);
  attachResponseRouter(ws);

  await authenticateWs(ws, walletKey, sessionKeyAddress, 'clearnode', expiresAt, allowances);

  ws.on('close', () => {
    userWsPool.delete(getAddress(userAddress as Address));
    stopUserPing(userAddress);
    console.log(`User WS closed: ${userAddress}`);
  });

  userWsPool.set(getAddress(userAddress as Address), ws);
  startUserPing(userAddress);
  return ws;
}

export function getUserWs(userAddress: string): WebSocket | undefined {
  const ws = userWsPool.get(getAddress(userAddress as Address));
  if (ws && ws.readyState === WebSocket.OPEN) return ws;
  return undefined;
}

export async function authenticateUserWs(
  userAddress: string,
  sessionKeyAddress: Address,
  expiresAt: bigint,
  allowances: Array<{ asset: string; amount: string }>,
): Promise<{
  ws: WebSocket;
  challengeRaw: string;
  eip712: {
    domain: { name: string };
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
}> {
  const checksumAddress = getAddress(userAddress as Address); // EIP-55

  const ws = await connectWs(YELLOW_WS_URL);
  attachResponseRouter(ws);

  const authParams: AuthRequestParams = {
    address: checksumAddress,
    session_key: sessionKeyAddress,
    application: 'clearnode',
    expires_at: expiresAt,
    scope: 'console',
    allowances,
  };

  // Send auth_request — get challenge back for user to sign
  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWait(ws, authReqMsg);
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  ws.on('close', () => {
    userWsPool.delete(getAddress(userAddress as Address));
    stopUserPing(userAddress);
    console.log(`User WS closed: ${userAddress}`);
  });

  userWsPool.set(getAddress(userAddress as Address), ws);

  // Build EIP-712 typed data for the frontend to sign
  const eip712 = {
    domain: { name: 'clearnode' },
    types: EIP712AuthTypes,
    primaryType: 'Policy' as const,
    message: {
      challenge: challengeParsed.params.challengeMessage,
      scope: authParams.scope,
      wallet: checksumAddress,
      session_key: sessionKeyAddress,
      expires_at: Number(expiresAt),
      allowances,
    },
  };

  return { ws, challengeRaw, eip712 };
}

// Keepalive timers for user WS connections
const userPingIntervals: Map<string, ReturnType<typeof setInterval>> = new Map();

function startUserPing(userAddress: string) {
  const addr = getAddress(userAddress as Address);
  // Clear existing interval if any
  const existing = userPingIntervals.get(addr);
  if (existing) clearInterval(existing);

  const interval = setInterval(() => {
    const ws = userWsPool.get(addr);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const pingMsg = createPingMessageV2();
      ws.send(pingMsg);
    } else {
      clearInterval(interval);
      userPingIntervals.delete(addr);
    }
  }, PING_INTERVAL_MS);
  userPingIntervals.set(addr, interval);
}

function stopUserPing(userAddress: string) {
  const addr = getAddress(userAddress as Address);
  const interval = userPingIntervals.get(addr);
  if (interval) {
    clearInterval(interval);
    userPingIntervals.delete(addr);
  }
}

export async function completeUserAuth(
  userAddress: string,
  signature: Hex,
  challengeRaw: string,
): Promise<string | undefined> {
  const ws = getUserWs(userAddress);
  if (!ws) throw new Error(`No WS found for user ${userAddress}`);

  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  // Proxy signer: returns the user's pre-signed EIP-712 signature
  const proxySigner = async () => signature;

  const authVerifyMsg = await createAuthVerifyMessage(proxySigner, challengeParsed);
  const verifyRaw = await sendAndWait(ws, authVerifyMsg);
  const verifyParsed = parseAnyRPCResponse(verifyRaw);

  if (verifyParsed.method === RPCMethod.Error) {
    throw new Error(`User auth verify failed: ${JSON.stringify(verifyParsed.params)}`);
  }

  // Extract JWT from auth_verify response
  const authVerifyParsed = parseAuthVerifyResponse(verifyRaw);
  const jwt = authVerifyParsed.params.jwtToken;

  // Start keepalive pings so the user WS stays alive for channel operations
  startUserPing(userAddress);
  console.log(`User WS authenticated and keepalive started: ${userAddress}`);

  return jwt;
}

// ---------------------------------------------------------------------------
// JWT DB helpers
// ---------------------------------------------------------------------------

async function storeUserJwt(userAddress: string, jwt: string): Promise<void> {
  await sessionKeyDb.query(
    `UPDATE session_keys SET jwt_token = $1 WHERE owner = $2 AND status = 'ACTIVE'`,
    [jwt, getAddress(userAddress as Address)],
  );
}

async function getUserJwt(userAddress: string): Promise<string | undefined> {
  const result = await sessionKeyDb.query(
    `SELECT jwt_token FROM session_keys WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW()
     LIMIT 1`,
    [getAddress(userAddress as Address)],
  );
  return result.rows[0]?.jwt_token || undefined;
}

export { storeUserJwt };

// ---------------------------------------------------------------------------
// ensureUserWs — reconnect via JWT if WS is dead
// ---------------------------------------------------------------------------

export async function ensureUserWs(userAddress: string): Promise<WebSocket> {
  const addr = getAddress(userAddress as Address);

  // 1. Check if WS is already alive
  const existing = getUserWs(addr);
  if (existing) return existing;

  // 2. Look up stored JWT
  const jwt = await getUserJwt(addr);
  if (!jwt) {
    throw new Error('No active session — please reconnect wallet');
  }

  // 3. Open new WS and re-auth with JWT (no wallet signature needed)
  const ws = await connectWs(YELLOW_WS_URL);
  attachResponseRouter(ws);

  // 3a. Send auth_request with stored session key info
  const skRow = await sessionKeyDb.query(
    `SELECT address, expires_at, allowances FROM session_keys
     WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW()
     LIMIT 1`,
    [addr],
  );
  if (skRow.rows.length === 0) {
    ws.close();
    throw new Error('No active session key — please reconnect wallet');
  }

  const skAddress = skRow.rows[0].address as Address;
  const expiresAt = BigInt(Math.floor(new Date(skRow.rows[0].expires_at).getTime() / 1000));
  const allowances = skRow.rows[0].allowances || [];

  const authParams: AuthRequestParams = {
    address: addr,
    session_key: skAddress,
    application: 'clearnode',
    expires_at: expiresAt,
    scope: 'console',
    allowances,
  };

  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWait(ws, authReqMsg);

  // 3b. Send JWT auth_verify (no signature required)
  const jwtVerifyMsg = await createAuthVerifyMessageWithJWT(jwt);
  const verifyRaw = await sendAndWait(ws, jwtVerifyMsg);
  const verifyParsed = parseAnyRPCResponse(verifyRaw);

  if (verifyParsed.method === RPCMethod.Error) {
    ws.close();
    throw new Error('Session expired — please reconnect wallet');
  }

  // 3c. Extract and store new JWT
  const authVerifyParsed = parseAuthVerifyResponse(verifyRaw);
  const newJwt = authVerifyParsed.params.jwtToken;
  if (newJwt) {
    await storeUserJwt(addr, newJwt);
  }

  // 3d. Add to pool and start keepalive
  ws.on('close', () => {
    userWsPool.delete(addr);
    stopUserPing(addr);
    console.log(`User WS closed (JWT reconnect): ${addr}`);
  });

  userWsPool.set(addr, ws);
  startUserPing(addr);
  console.log(`User WS reconnected via JWT: ${addr}`);

  return ws;
}

// ---------------------------------------------------------------------------
// Settlement helpers (used by settlementWorker)
// ---------------------------------------------------------------------------

export function getEngineWs(): WebSocket | null {
  return engineWs;
}

export function getEngineAddress(): Address {
  if (!ENGINE_WALLET_KEY) throw new Error('ENGINE_WALLET_KEY not set');
  return privateKeyToAccount(ENGINE_WALLET_KEY).address;
}

export function getEngineSessionKeyAddress(): Address | null {
  return engineSessionKeyAddress;
}

export async function createAppSession(
  sellerSignerKey: Hex,
  buyerSignerKey: Hex,
  participants: [Address, Address, Address], // [seller, buyer, engine]
  allocations: Array<{ participant: Address; asset: string; amount: string }>,
): Promise<string> {
  if (!engineWs || !engineMessageSigner) throw new Error('Engine WS not connected');

  const sellerSigner = createECDSAMessageSigner(sellerSignerKey);
  const buyerSigner = createECDSAMessageSigner(buyerSignerKey);

  const definition = {
    protocol: RPCProtocolVersion.NitroRPC_0_4,
    participants,
    weights: [0, 0, 100], // engine is judge
    quorum: 100,
    challenge: 0,
    nonce: Date.now(),
    application: 'dark-pool',
  };

  // Create message signed by seller
  const createMsg = await createAppSessionMessage(sellerSigner, {
    definition,
    allocations,
  });

  // Sign the SAME req payload with buyer's signer
  const msgObj = JSON.parse(createMsg);
  const buyerSig = await buyerSigner(msgObj.req);
  msgObj.sig.push(buyerSig);

  const raw = await sendAndWait(engineWs, JSON.stringify(msgObj));
  const anyParsed = parseAnyRPCResponse(raw);
  if (anyParsed.method === RPCMethod.Error) {
    throw new Error(`create_app_session rejected by clearnode: ${JSON.stringify(anyParsed.params)}`);
  }
  const parsed = parseCreateAppSessionResponse(raw);
  return parsed.params.appSessionId;
}

export async function closeAppSession(
  appSessionId: Hex,
  allocations: Array<{ participant: Address; asset: string; amount: string }>,
): Promise<void> {
  if (!engineWs || !engineMessageSigner) throw new Error('Engine WS not connected');

  const closeMsg = await createCloseAppSessionMessage(engineMessageSigner, {
    app_session_id: appSessionId,
    allocations,
  });

  const raw = await sendAndWait(engineWs, closeMsg);
  const anyParsed = parseAnyRPCResponse(raw);
  if (anyParsed.method === RPCMethod.Error) {
    throw new Error(`close_app_session rejected by clearnode: ${JSON.stringify(anyParsed.params)}`);
  }
  const parsed = parseCloseAppSessionResponse(raw);

  if (parsed.params.status !== 'closed') {
    throw new Error(`Close app session failed: status=${parsed.params.status}`);
  }
}

export async function revokeSessionKey(sessionKeyAddress: Address): Promise<void> {
  if (!engineWs || !engineMessageSigner) throw new Error('Engine WS not connected');

  const revokeMsg = await createRevokeSessionKeyMessage(engineMessageSigner, sessionKeyAddress);
  const raw = await sendAndWait(engineWs, revokeMsg);
  const parsed = parseAnyRPCResponse(raw);

  if (parsed.method === RPCMethod.Error) {
    throw new Error(`Revoke failed: ${JSON.stringify(parsed.params)}`);
  }
}

// ---------------------------------------------------------------------------
// Channel management (used for Yellow deposit flow)
// ---------------------------------------------------------------------------

export interface ChannelInfo {
  channelId: string;
  channel: {
    participants: string[];
    adjudicator: string;
    challenge: number;
    nonce: number;
  };
  state: {
    intent: number;
    version: number;
    stateData: string;
    allocations: Array<{
      destination: string;
      token: string;
      amount: string;
    }>;
  };
  serverSignature: string;
}

export interface LedgerBalance {
  asset: string;
  amount: string;
}

export interface ChannelRecord {
  channelId: string;
  status: string;
  token: string;
  amount: string;
  chainId: number;
}

/**
 * Request channel creation from the clearnode.
 * Returns channel params + broker signature for on-chain Custody.create().
 * Must use the USER's authenticated WS — clearnode checks c.UserID matches signer.
 */
export async function requestCreateChannel(
  userAddress: Address,
  chainId: number,
  token: string,
): Promise<ChannelInfo> {
  const addr = getAddress(userAddress);
  const ws = await ensureUserWs(addr);

  // Sign with user's session key from DB
  const signer = await getUserSessionKeySigner(addr);

  const msg = await createCreateChannelMessage(signer, {
    chain_id: chainId,
    token: token as `0x${string}`,
  });

  const raw = await sendAndWait(ws, msg);
  const parsed = parseAnyRPCResponse(raw);

  if (parsed.method === RPCMethod.Error) {
    throw new Error(`create_channel rejected: ${JSON.stringify(parsed.params)}`);
  }

  const data = parsed.params as any;

  // SDK's parseAnyRPCResponse transforms snake_case → camelCase,
  // so use camelCase fields (serverSignature, channelId, stateData).
  // Fall back to snake_case in case raw response leaks through.
  const serverSig = data.serverSignature || data.server_signature || '';
  if (!serverSig) {
    console.error('[createChannel] WARNING: empty server signature! Raw params:', JSON.stringify(data, null, 2));
  }

  return {
    channelId: data.channelId || data.channel_id,
    channel: {
      participants: data.channel?.participants || [],
      adjudicator: data.channel?.adjudicator || '',
      challenge: data.channel?.challenge || 3600,
      nonce: data.channel?.nonce || 0,
    },
    state: {
      intent: data.state?.intent || 1,
      version: data.state?.version || 0,
      stateData: data.state?.stateData || data.state?.state_data || '0x',
      allocations: (data.state?.allocations || []).map((a: any) => ({
        destination: a.destination || a.participant,
        token: a.token || a.token_address,
        amount: String(a.amount || '0'),
      })),
    },
    serverSignature: serverSig,
  };
}

/**
 * Request channel resize from the clearnode.
 * Returns updated state + broker signature for on-chain Custody.resize().
 * Must use the USER's authenticated WS — clearnode checks c.UserID matches signer.
 */
export async function requestResizeChannel(
  userAddress: Address,
  channelId: string,
  resizeAmount: string,
  allocateAmount: string,
): Promise<ChannelInfo> {
  const addr = getAddress(userAddress);
  const ws = await ensureUserWs(addr);

  const signer = await getUserSessionKeySigner(addr);

  const msg = await createResizeChannelMessage(signer, {
    channel_id: channelId as `0x${string}`,
    resize_amount: BigInt(resizeAmount),
    allocate_amount: BigInt(allocateAmount),
    funds_destination: addr,
  });

  const raw = await sendAndWait(ws, msg);
  const parsed = parseAnyRPCResponse(raw);

  if (parsed.method === RPCMethod.Error) {
    throw new Error(`resize_channel rejected: ${JSON.stringify(parsed.params)}`);
  }

  const data = parsed.params as any;

  const serverSig = data.serverSignature || data.server_signature || '';
  if (!serverSig) {
    console.error('[resizeChannel] WARNING: empty server signature! Raw params:', JSON.stringify(data, null, 2));
  }

  return {
    channelId: data.channelId || data.channel_id,
    channel: { participants: [], adjudicator: '', challenge: 0, nonce: 0 },
    state: {
      intent: data.state?.intent || 2,
      version: data.state?.version || 0,
      stateData: data.state?.stateData || data.state?.state_data || '0x',
      allocations: (data.state?.allocations || []).map((a: any) => ({
        destination: a.destination || a.participant,
        token: a.token || a.token_address,
        amount: String(a.amount || '0'),
      })),
    },
    serverSignature: serverSig,
  };
}

/**
 * Get unified (ledger) balances for a user from the clearnode.
 * Uses the engine's WS with accountId param — no per-user WS needed.
 */
export async function getLedgerBalances(
  userAddress: Address,
): Promise<LedgerBalance[]> {
  if (!engineWs || !engineMessageSigner) throw new Error('Engine WS not connected');

  const addr = getAddress(userAddress);
  const msg = await createGetLedgerBalancesMessage(engineMessageSigner, addr);

  const raw = await sendAndWait(engineWs, msg);
  const parsed = parseAnyRPCResponse(raw);

  if (parsed.method === RPCMethod.Error) {
    throw new Error(`get_ledger_balances failed: ${JSON.stringify(parsed.params)}`);
  }

  const data = parsed.params as any;
  return (data.ledger_balances || []).map((b: any) => ({
    asset: b.asset,
    amount: b.amount,
  }));
}

/**
 * Get user's channels from the clearnode (no auth required, but uses authenticated WS).
 */
export async function getChannels(
  userAddress?: Address,
): Promise<ChannelRecord[]> {
  if (!engineWs) throw new Error('Engine WS not connected');

  const participant = userAddress ? getAddress(userAddress) : undefined;
  const msg = createGetChannelsMessageV2(participant, 'open' as any);

  const raw = await sendAndWait(engineWs, msg);
  const parsed = parseAnyRPCResponse(raw);

  if (parsed.method === RPCMethod.Error) {
    throw new Error(`get_channels failed: ${JSON.stringify(parsed.params)}`);
  }

  const data = parsed.params as any;
  const channels = data.channels || data || [];
  if (!Array.isArray(channels)) return [];

  return channels.map((ch: any) => ({
    channelId: ch.channel_id || ch.channelId,
    status: ch.status,
    token: ch.token,
    amount: String(ch.amount || '0'),
    chainId: ch.chain_id || ch.chainId || 0,
  }));
}

/**
 * Helper: get a MessageSigner for a user's session key from the DB.
 */
async function getUserSessionKeySigner(userAddress: string) {
  // We need the DB pool — import it from the module scope
  // The session key private key is stored encrypted in DB
  const result = await sessionKeyDb.query(
    `SELECT private_key FROM session_keys
     WHERE owner = $1 AND status = 'ACTIVE' AND expires_at > NOW()
     LIMIT 1`,
    [getAddress(userAddress as Address)],
  );

  if (result.rows.length === 0) {
    throw new Error(`No active session key for ${userAddress}`);
  }

  return createECDSAMessageSigner(result.rows[0].private_key as Hex);
}

// DB reference for session key lookups (set during init)
let sessionKeyDb: Pool;

export function setChannelDb(pool: Pool): void {
  sessionKeyDb = pool;
}

export { sendAndWait };
