import { WebSocket } from 'ws';
import { Pool } from 'pg';
import { createWalletClient, http, Hex, Address, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  createAuthRequestMessage,
  createAuthVerifyMessage,
  createEIP712AuthMessageSigner,
  createECDSAMessageSigner,
  createGetAssetsMessageV2,
  createAppSessionMessage,
  createCloseAppSessionMessage,
  createRevokeSessionKeyMessage,
  parseAuthChallengeResponse,
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
const RESPONSE_TIMEOUT = 10_000;

// Asset map: token address -> Yellow symbol (e.g. "0x1234..." -> "usdc")
let assetMap: Map<string, string> = new Map();

// Engine's persistent WS connection
let engineWs: WebSocket | null = null;
let engineSessionKeyAddress: Address | null = null;
let engineMessageSigner: ReturnType<typeof createECDSAMessageSigner> | null = null;

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

  // Auto-reconnect on close
  engineWs.on('close', () => {
    console.warn('Engine WS closed, reconnecting in 5s...');
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
      assetMap.set(asset.token.toLowerCase(), asset.symbol.toLowerCase());
    }
  }

  console.log(`Loaded ${assetMap.size} assets from Yellow Network`);
}

export function getAssetSymbol(tokenAddress: string): string | undefined {
  return assetMap.get(tokenAddress.toLowerCase());
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
  const existingWs = userWsPool.get(userAddress.toLowerCase());
  if (existingWs && existingWs.readyState === WebSocket.OPEN) {
    return existingWs;
  }

  const ws = await connectWs(YELLOW_WS_URL);
  attachResponseRouter(ws);

  await authenticateWs(ws, walletKey, sessionKeyAddress, 'dark-pool', expiresAt, allowances);

  ws.on('close', () => {
    userWsPool.delete(userAddress.toLowerCase());
    console.log(`User WS closed: ${userAddress}`);
  });

  userWsPool.set(userAddress.toLowerCase(), ws);
  return ws;
}

export function getUserWs(userAddress: string): WebSocket | undefined {
  const ws = userWsPool.get(userAddress.toLowerCase());
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
    application: 'dark-pool',
    expires_at: expiresAt,
    scope: 'console',
    allowances,
  };

  // Send auth_request — get challenge back for user to sign
  const authReqMsg = await createAuthRequestMessage(authParams);
  const challengeRaw = await sendAndWait(ws, authReqMsg);
  const challengeParsed = parseAuthChallengeResponse(challengeRaw);

  ws.on('close', () => {
    userWsPool.delete(userAddress.toLowerCase());
  });

  userWsPool.set(userAddress.toLowerCase(), ws);

  // Build EIP-712 typed data for the frontend to sign
  const eip712 = {
    domain: { name: 'dark-pool' },
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

export async function completeUserAuth(
  userAddress: string,
  signature: Hex,
  challengeRaw: string,
): Promise<void> {
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

export { sendAndWait };
