import { useState, useCallback } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { parseUnits, maxUint256, keccak256, encodeAbiParameters, zeroAddress } from 'viem';
import {
  requestCreateChannel,
  requestResizeChannel,
  getChannels,
  type ChannelInfo,
} from '@/services/api';
import { useUnifiedBalance } from '@/providers/UnifiedBalanceProvider';
import { CUSTODY_ADDRESS, CUSTODY_ABI, ERC20_ABI } from '@/config/contracts';

const NATIVE_ETH = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export type DepositStep =
  | 'idle'
  | 'checking_channel'
  | 'creating_channel'
  | 'signing_channel_state'
  | 'submitting_create'
  | 'approving_token'
  | 'depositing'
  | 'requesting_resize'
  | 'signing_resize_state'
  | 'submitting_resize'
  | 'closing_channel'
  | 'submitting_close'
  | 'complete'
  | 'error';

const STEP_MESSAGES: Record<DepositStep, string> = {
  idle: '',
  checking_channel: 'Checking Yellow Network channel\u2026',
  creating_channel: 'Requesting channel from Yellow\u2026',
  signing_channel_state: 'Sign channel state in wallet\u2026',
  submitting_create: 'Creating channel on-chain\u2026',
  approving_token: 'Approving token spend\u2026',
  depositing: 'Depositing to Yellow Custody\u2026',
  requesting_resize: 'Requesting channel resize\u2026',
  signing_resize_state: 'Sign resize state in wallet\u2026',
  submitting_resize: 'Submitting resize on-chain\u2026',
  closing_channel: 'Closing channel to unlock funds\u2026',
  submitting_close: 'Finalizing on-chain\u2026',
  complete: 'Deposit complete!',
  error: 'Error',
};

interface UseYellowDepositReturn {
  step: DepositStep;
  stepMessage: string;
  loading: boolean;
  error: string | null;
  deposit: (token: string, amount: string, decimals: number) => Promise<void>;
  reset: () => void;
}

/**
 * Hook for depositing to Yellow Network through the channel lifecycle.
 *
 * Flow:
 * 1. Check if user has a channel for this token (if not, create one)
 * 2. Deposit to Custody contract on-chain
 * 3. Resize channel to move funds from Custody ledger → unified balance
 *
 * After completion, the user's unified balance is credited and they can trade.
 */
export function useYellowDeposit(): UseYellowDepositReturn {
  const { address, isConnected, chain } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { refreshBalances } = useUnifiedBalance();

  const [step, setStep] = useState<DepositStep>('idle');
  const [error, setError] = useState<string | null>(null);

  const loading = step !== 'idle' && step !== 'complete' && step !== 'error';
  const stepMessage = STEP_MESSAGES[step];

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
  }, []);

  const deposit = useCallback(
    async (token: string, amount: string, decimals: number): Promise<void> => {
      setError(null);
      setStep('idle');

      if (!isConnected || !address || !walletClient || !publicClient || !chain) {
        setError('Wallet must be connected');
        return;
      }

      if (CUSTODY_ADDRESS === '0x0000000000000000000000000000000000000000') {
        setError('CUSTODY_ADDRESS not configured');
        return;
      }

      try {
        const isNativeETH = token.toLowerCase() === NATIVE_ETH.toLowerCase();
        // Custody contract uses address(0) for native ETH
        const custodyToken = isNativeETH ? zeroAddress : (token as `0x${string}`);
        const rawAmount = parseUnits(amount, decimals);

        console.log('[useYellowDeposit] ═══ STARTING DEPOSIT ═══');
        console.log('[useYellowDeposit] Token:', token);
        console.log('[useYellowDeposit] Custody token:', custodyToken);
        console.log('[useYellowDeposit] Amount:', amount, 'decimals:', decimals);
        console.log('[useYellowDeposit] Raw amount:', rawAmount.toString());
        console.log('[useYellowDeposit] User:', address);
        console.log('[useYellowDeposit] Chain:', chain.id);

        // Step 1: Check if user has a channel for this token
        setStep('checking_channel');
        console.log('[useYellowDeposit] 1️⃣ Fetching channels...');
        let channels = await getChannels(address);
        console.log('[useYellowDeposit] Got', channels.length, 'channel(s):', JSON.stringify(channels, null, 2));

        let channel = channels.find(
          (ch) => ch.token?.toLowerCase() === custodyToken.toLowerCase() && ch.status === 'open'
        );
        console.log('[useYellowDeposit] Found matching channel:', channel ? 'YES' : 'NO');
        if (channel) {
          console.log('[useYellowDeposit] Channel details:', JSON.stringify(channel, null, 2));
        } else {
          console.log('[useYellowDeposit] No open channel for token', custodyToken);
          console.log('[useYellowDeposit] All channels:', channels.map(ch => ({
            id: ch.channelId?.substring(0, 20) + '...',
            token: ch.token,
            status: ch.status,
          })));
        }

        // Save preceding state for the resize proof (adjudicator requires it)
        let precedingStateSigs: `0x${string}`[] = [];
        let precedingStateData: `0x${string}` = '0x';
        let precedingAllocations: { destination: `0x${string}`; token: `0x${string}`; amount: bigint }[] | undefined;
        let precedingIntent: number = 1; // INITIALIZE by default
        let precedingVersion: bigint = 0n;

        // Step 2: Create channel if needed, OR fetch existing state
        if (!channel) {
          console.log('[useYellowDeposit] 2️⃣ No channel exists, creating new one...');
          setStep('creating_channel');
          console.log('[useYellowDeposit] Requesting channel creation from clearnode...');
          const channelInfo = await requestCreateChannel(address, custodyToken, chain.id);
          console.log('[useYellowDeposit] Channel creation response:', {
            channelId: channelInfo.channelId,
            participants: channelInfo.channel.participants,
            adjudicator: channelInfo.channel.adjudicator,
            nonce: channelInfo.channel.nonce,
          });

          // Sign the channel initial state with EIP-191 (personal_sign)
          setStep('signing_channel_state');
          const userSig = await signChannelState(
            walletClient,
            channelInfo,
            chain.id,
          );

          // Save initial state as preceding state for the first resize
          precedingStateSigs = [userSig, channelInfo.serverSignature as `0x${string}`];
          precedingStateData = (channelInfo.state.stateData || '0x') as `0x${string}`;
          precedingAllocations = channelInfo.state.allocations.map((a) => ({
            destination: a.destination as `0x${string}`,
            token: a.token as `0x${string}`,
            amount: BigInt(a.amount),
          }));
          precedingIntent = channelInfo.state.intent;
          precedingVersion = BigInt(channelInfo.state.version);

          // Submit Custody.create() on-chain
          setStep('submitting_create');
          console.log('[useYellowDeposit] 3️⃣ Submitting Custody.create() on-chain...');
          console.log('[useYellowDeposit] Channel params:', {
            participants: channelInfo.channel.participants,
            adjudicator: channelInfo.channel.adjudicator,
            challenge: channelInfo.channel.challenge,
            nonce: channelInfo.channel.nonce,
          });
          console.log('[useYellowDeposit] Initial state:', {
            intent: channelInfo.state.intent,
            version: channelInfo.state.version,
            allocations: precedingAllocations,
            sigsCount: precedingStateSigs.length,
          });

          const createHash = await walletClient.writeContract({
            address: CUSTODY_ADDRESS,
            abi: CUSTODY_ABI,
            functionName: 'create',
            args: [
              {
                participants: channelInfo.channel.participants.map((p) => p as `0x${string}`),
                adjudicator: channelInfo.channel.adjudicator as `0x${string}`,
                challenge: BigInt(channelInfo.channel.challenge),
                nonce: BigInt(channelInfo.channel.nonce),
              },
              {
                intent: channelInfo.state.intent,
                version: BigInt(channelInfo.state.version),
                data: precedingStateData,
                allocations: precedingAllocations,
                sigs: precedingStateSigs,
              },
            ],
          });
          console.log('[useYellowDeposit] ✓ Transaction submitted:', createHash);
          await publicClient.waitForTransactionReceipt({ hash: createHash });
          console.log('[useYellowDeposit] ✓ Transaction confirmed');

          // Refresh channels to get the new channel ID
          // Give the clearnode a moment to process the Created event
          console.log('[useYellowDeposit] Waiting 3s for clearnode to index Created event...');
          await new Promise((r) => setTimeout(r, 3000));
          console.log('[useYellowDeposit] Refreshing channels...');
          channels = await getChannels(address);
          channel = channels.find(
            (ch) => ch.token?.toLowerCase() === custodyToken.toLowerCase() && ch.status === 'open'
          );

          if (!channel) {
            console.error('[useYellowDeposit] ✗ Channel not found after create. Channels:', channels);
            throw new Error('Channel created but not yet visible. Please retry in a few seconds.');
          }
          console.log('[useYellowDeposit] ✓ Channel found after create:', channel.channelId);
        } else {
          console.log('[useYellowDeposit] 2️⃣ Using EXISTING channel:', channel.channelId);
          // Existing channel — read lastValidState from contract via getChannelData
          console.log('[useYellowDeposit] Reading on-chain channel state...');
          const channelData = await publicClient.readContract({
            address: CUSTODY_ADDRESS,
            abi: CUSTODY_ABI,
            functionName: 'getChannelData',
            args: [channel.channelId as `0x${string}`],
          });
          // getChannelData returns [channel, status, wallets, challengeExpiry, lastValidState]
          // Destructure the tuple to avoid readonly cast issues
          const [, , , , lastValidState] = channelData;
          precedingIntent = Number(lastValidState.intent);
          precedingVersion = BigInt(lastValidState.version);
          precedingStateData = lastValidState.data as `0x${string}`;
          precedingAllocations = lastValidState.allocations.map((a: any) => ({
            destination: a.destination as `0x${string}`,
            token: a.token as `0x${string}`,
            amount: BigInt(a.amount),
          }));
          precedingStateSigs = lastValidState.sigs as `0x${string}`[];
          console.log('[useYellowDeposit] ✓ Fetched preceding state from contract:', {
            intent: precedingIntent,
            version: precedingVersion.toString(),
            allocationsCount: precedingAllocations.length,
            sigsCount: precedingStateSigs.length,
          });
        }

        // Step 3: Deposit to Custody on-chain
        console.log('[useYellowDeposit] 3️⃣ Depositing to Custody contract...');
        if (!isNativeETH) {
          // ERC-20: approve if needed
          const allowance = await publicClient.readContract({
            address: token as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, CUSTODY_ADDRESS],
          });
          console.log('[useYellowDeposit] Current allowance:', (allowance as bigint).toString());
          if ((allowance as bigint) < rawAmount) {
            console.log('[useYellowDeposit] Approving token spend...');
            setStep('approving_token');
            const approveHash = await walletClient.writeContract({
              address: token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [CUSTODY_ADDRESS, maxUint256],
            });
            console.log('[useYellowDeposit] ✓ Approval tx:', approveHash);
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
            console.log('[useYellowDeposit] ✓ Approval confirmed');
          }
        }

        setStep('depositing');
        console.log('[useYellowDeposit] Calling Custody.deposit()...');
        const depositHash = await walletClient.writeContract({
          address: CUSTODY_ADDRESS,
          abi: CUSTODY_ABI,
          functionName: 'deposit',
          args: [address, custodyToken, rawAmount],
          value: isNativeETH ? rawAmount : 0n,
        });
        console.log('[useYellowDeposit] ✓ Deposit tx:', depositHash);
        await publicClient.waitForTransactionReceipt({ hash: depositHash });
        console.log('[useYellowDeposit] ✓ Deposit confirmed');

        // Step 4: Resize channel to move funds from Custody ledger → unified balance
        // resize_amount = +rawAmount ONLY (pull from custody ledger into channel on-chain)
        // The clearnode's handleResized auto-credits the unified balance when
        // DeltaAllocations[0] > 0. Using allocate_amount=-X would cancel out
        // the delta to zero, preventing the credit.
        console.log('[useYellowDeposit] 4️⃣ Requesting channel resize from clearnode...');
        setStep('requesting_resize');
        const resizeInfo = await requestResizeChannel(
          address,
          channel.channelId,
          rawAmount.toString(),
          '0', // allocate_amount must be 0 — see DEPOSIT_INVESTIGATION.md
        );
        console.log('[useYellowDeposit] Resize response:', {
          channelId: resizeInfo.channelId,
          intent: resizeInfo.state.intent,
          version: resizeInfo.state.version,
          allocations: resizeInfo.state.allocations,
        });

        // Sign the resize state
        setStep('signing_resize_state');
        console.log('[useYellowDeposit] Signing resize state...');
        const resizeSig = await signChannelState(
          walletClient,
          resizeInfo,
          chain.id,
        );
        console.log('[useYellowDeposit] ✓ Resize state signed');

        // Submit Custody.resize() on-chain
        setStep('submitting_resize');
        console.log('[useYellowDeposit] 5️⃣ Submitting Custody.resize() on-chain...');
        // Build the preceding state proof — either initial state (new channel) or current on-chain state (existing channel)
        // The adjudicator validates this state has valid signatures from both participants
        const precedingAllocsForProof = precedingAllocations
          || resizeInfo.state.allocations.map((a) => ({
            destination: a.destination as `0x${string}`,
            token: a.token as `0x${string}`,
            amount: 0n,
          }));

        console.log('[useYellowDeposit] Resize args:', {
          channelId: channel.channelId,
          newState: {
            intent: resizeInfo.state.intent,
            version: resizeInfo.state.version,
            allocationsCount: resizeInfo.state.allocations.length,
          },
          precedingState: {
            intent: precedingIntent,
            version: precedingVersion.toString(),
            allocationsCount: precedingAllocsForProof.length,
            sigsCount: precedingStateSigs.length,
          },
        });

        const resizeHash = await walletClient.writeContract({
          address: CUSTODY_ADDRESS,
          abi: CUSTODY_ABI,
          functionName: 'resize',
          args: [
            channel.channelId as `0x${string}`,
            {
              intent: resizeInfo.state.intent,
              version: BigInt(resizeInfo.state.version),
              data: (resizeInfo.state.stateData || '0x') as `0x${string}`,
              allocations: resizeInfo.state.allocations.map((a) => ({
                destination: a.destination as `0x${string}`,
                token: a.token as `0x${string}`,
                amount: BigInt(a.amount),
              })),
              sigs: [resizeSig, resizeInfo.serverSignature as `0x${string}`],
            },
            // Proofs: preceding state (initial state for new channels, current state for existing)
            [{
              intent: precedingIntent,
              version: precedingVersion,
              data: precedingStateData,
              allocations: precedingAllocsForProof,
              sigs: precedingStateSigs,
            }],
          ],
        });
        console.log('[useYellowDeposit] ✓ Resize tx:', resizeHash);
        await publicClient.waitForTransactionReceipt({ hash: resizeHash });
        console.log('[useYellowDeposit] ✓ Resize confirmed');

        // Retry refreshing shared balance — clearnode needs time to process the Resized event
        console.log('[useYellowDeposit] 6️⃣ Waiting for clearnode to credit unified balance...');
        const delays = [2000, 3000, 5000];
        for (const delay of delays) {
          await new Promise((r) => setTimeout(r, delay));
          console.log('[useYellowDeposit] Refreshing balances...');
          await refreshBalances();
        }

        // 🆕 Step 7: Close the channel to move funds to unified balance
        console.log('[useYellowDeposit] 7️⃣ Closing channel to move funds to unified balance...');
        setStep('closing_channel');

        const closeResult = await fetch(`${API_URL}/api/channel/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address,
            channelId: channel.channelId,
            fundsDestination: address,
          }),
        });

        if (!closeResult.ok) {
          throw new Error(`Close channel failed: ${await closeResult.text()}`);
        }

        const closeInfo = await closeResult.json();
        console.log('[useYellowDeposit] Close prepared by clearnode');

        // Step 8: Submit close transaction on-chain
        setStep('submitting_close');
        const closeSig = await signChannelState(walletClient, closeInfo, chain.id);

        const closeHash = await walletClient.writeContract({
          address: CUSTODY_ADDRESS,
          abi: CUSTODY_ABI,
          functionName: 'close',
          args: [
            {
              intent: closeInfo.state.intent,
              version: BigInt(closeInfo.state.version),
              data: (closeInfo.state.stateData || '0x') as `0x${string}`,
              allocations: closeInfo.state.allocations.map((a: any) => ({
                destination: a.destination as `0x${string}`,
                token: a.token as `0x${string}`,
                amount: BigInt(a.amount),
              })),
              sigs: [closeSig, closeInfo.serverSignature as `0x${string}`],
            },
            (closeInfo.state.stateData || '0x') as `0x${string}`,
          ],
        });

        console.log('[useYellowDeposit] ✓ Close tx:', closeHash);
        await publicClient.waitForTransactionReceipt({ hash: closeHash });
        console.log('[useYellowDeposit] ✓ Channel closed - funds moved to unified balance');

        // Final refresh
        await new Promise((r) => setTimeout(r, 2000));
        await refreshBalances();

        console.log('[useYellowDeposit] ✓ DEPOSIT COMPLETE');
        setStep('complete');
      } catch (err) {
        console.error('[useYellowDeposit] ✗✗✗ DEPOSIT FAILED ✗✗✗');
        console.error('[useYellowDeposit] Error:', err);
        console.error('[useYellowDeposit] Stack:', (err as Error)?.stack);
        setStep('error');
        if (err instanceof Error) {
          console.error('[useYellowDeposit] Error message:', err.message);
          setError(err.message);
        } else {
          console.error('[useYellowDeposit] Unknown error:', JSON.stringify(err));
          setError('Deposit failed');
        }
      }
    },
    [address, isConnected, chain, walletClient, publicClient, refreshBalances]
  );

  return {
    step,
    stepMessage,
    loading,
    error,
    deposit,
    reset,
  };
}

/**
 * Sign a channel state using EIP-191 (personal_sign) via MetaMask.
 * Matches the Nitrolite SDK's WalletStateSigner approach:
 *   1. ABI-encode the full packed state (channelId, intent, version, data, allocations)
 *   2. Sign with personal_sign (EIP-191) over the raw packed bytes
 * The Custody contract's verifyStateEOASignature() recovers this via
 * MessageHashUtils.toEthSignedMessageHash(bytes memory) — the full packed state overload.
 */
async function signChannelState(
  walletClient: { signMessage: (args: any) => Promise<`0x${string}`> },
  channelInfo: ChannelInfo,
  chainId: number,
): Promise<`0x${string}`> {
  // Use channelId from clearnode response if available (resize flow returns it directly).
  // Only compute from channel params for create flow where we derive it locally.
  let channelId: `0x${string}`;
  if (channelInfo.channelId) {
    channelId = channelInfo.channelId as `0x${string}`;
  } else {
    const channelEncoded = encodeAbiParameters(
      [{ type: 'address[]' }, { type: 'address' }, { type: 'uint64' }, { type: 'uint64' }, { type: 'uint256' }],
      [
        channelInfo.channel.participants.map((p) => p as `0x${string}`),
        channelInfo.channel.adjudicator as `0x${string}`,
        BigInt(channelInfo.channel.challenge),
        BigInt(channelInfo.channel.nonce),
        BigInt(chainId),
      ],
    );
    channelId = keccak256(channelEncoded);
  }

  // Pack the state matching SDK's getPackedState / contract's Utils.getPackedState
  const packedState = encodeAbiParameters(
    [
      { type: 'bytes32' },
      { type: 'uint8' },
      { type: 'uint256' },
      { type: 'bytes' },
      {
        type: 'tuple[]',
        components: [
          { type: 'address' },
          { type: 'address' },
          { type: 'uint256' },
        ],
      },
    ],
    [
      channelId,
      channelInfo.state.intent,
      BigInt(channelInfo.state.version),
      (channelInfo.state.stateData || '0x') as `0x${string}`,
      channelInfo.state.allocations.map((a) => [
        a.destination as `0x${string}`,
        a.token as `0x${string}`,
        BigInt(a.amount),
      ] as [`0x${string}`, `0x${string}`, bigint]),
    ],
  );

  // Sign with EIP-191 (personal_sign) — MetaMask will show "Sign message" prompt
  return walletClient.signMessage({ message: { raw: packedState } });
}
