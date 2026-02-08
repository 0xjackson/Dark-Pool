import { useState, useCallback } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { parseUnits, maxUint256, keccak256, encodeAbiParameters, zeroAddress } from 'viem';
import {
  requestCreateChannel,
  requestResizeChannel,
  getLedgerBalances,
  getChannels,
  type ChannelInfo,
  type LedgerBalance,
} from '@/services/api';
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
  complete: 'Deposit complete!',
  error: 'Error',
};

interface UseYellowDepositReturn {
  step: DepositStep;
  stepMessage: string;
  loading: boolean;
  error: string | null;
  balances: LedgerBalance[];
  deposit: (token: string, amount: string, decimals: number) => Promise<void>;
  refreshBalances: () => Promise<void>;
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

  const [step, setStep] = useState<DepositStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<LedgerBalance[]>([]);

  const loading = step !== 'idle' && step !== 'complete' && step !== 'error';
  const stepMessage = STEP_MESSAGES[step];

  const reset = useCallback(() => {
    setStep('idle');
    setError(null);
  }, []);

  const refreshBalances = useCallback(async () => {
    if (!address) return;
    try {
      const b = await getLedgerBalances(address);
      setBalances(b);
    } catch {
      // Silently fail — balances will show as empty
    }
  }, [address]);

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

        // Step 1: Check if user has a channel for this token
        setStep('checking_channel');
        let channels = await getChannels(address);
        let channel = channels.find(
          (ch) => ch.token?.toLowerCase() === custodyToken.toLowerCase() && ch.status === 'open'
        );

        // Save initial state sigs for the resize proof (adjudicator requires them)
        let initialStateSigs: `0x${string}`[] = [];
        let initialStateData: `0x${string}` = '0x';
        let initialAllocations: { destination: `0x${string}`; token: `0x${string}`; amount: bigint }[] | undefined;

        // Step 2: Create channel if needed
        if (!channel) {
          setStep('creating_channel');
          const channelInfo = await requestCreateChannel(address, custodyToken, chain.id);

          // Sign the channel initial state with EIP-191 (personal_sign)
          setStep('signing_channel_state');
          const userSig = await signChannelState(
            walletClient,
            channelInfo,
            chain.id,
          );

          // Save initial state info for resize proof
          initialStateSigs = [userSig, channelInfo.serverSignature as `0x${string}`];
          initialStateData = (channelInfo.state.stateData || '0x') as `0x${string}`;
          initialAllocations = channelInfo.state.allocations.map((a) => ({
            destination: a.destination as `0x${string}`,
            token: a.token as `0x${string}`,
            amount: BigInt(a.amount),
          }));

          // Submit Custody.create() on-chain
          setStep('submitting_create');
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
                data: initialStateData,
                allocations: initialAllocations,
                sigs: initialStateSigs,
              },
            ],
          });
          await publicClient.waitForTransactionReceipt({ hash: createHash });

          // Refresh channels to get the new channel ID
          // Give the clearnode a moment to process the Created event
          await new Promise((r) => setTimeout(r, 3000));
          channels = await getChannels(address);
          channel = channels.find(
            (ch) => ch.token?.toLowerCase() === custodyToken.toLowerCase() && ch.status === 'open'
          );

          if (!channel) {
            throw new Error('Channel created but not yet visible. Please retry in a few seconds.');
          }
        }

        // Step 3: Deposit to Custody on-chain
        if (!isNativeETH) {
          // ERC-20: approve if needed
          const allowance = await publicClient.readContract({
            address: token as `0x${string}`,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, CUSTODY_ADDRESS],
          });
          if ((allowance as bigint) < rawAmount) {
            setStep('approving_token');
            const approveHash = await walletClient.writeContract({
              address: token as `0x${string}`,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [CUSTODY_ADDRESS, maxUint256],
            });
            await publicClient.waitForTransactionReceipt({ hash: approveHash });
          }
        }

        setStep('depositing');
        const depositHash = await walletClient.writeContract({
          address: CUSTODY_ADDRESS,
          abi: CUSTODY_ABI,
          functionName: 'deposit',
          args: [address, custodyToken, rawAmount],
          value: isNativeETH ? rawAmount : 0n,
        });
        await publicClient.waitForTransactionReceipt({ hash: depositHash });

        // Step 4: Resize channel to move funds from Custody ledger → unified balance
        // resize_amount = +rawAmount (pull from custody ledger into channel on-chain)
        // allocate_amount = -rawAmount (push from channel into unified balance)
        // Net effect: channel stays at zero, unified balance credited
        setStep('requesting_resize');
        const resizeInfo = await requestResizeChannel(
          address,
          channel.channelId,
          rawAmount.toString(),
          `-${rawAmount.toString()}`,
        );

        // Sign the resize state
        setStep('signing_resize_state');
        const resizeSig = await signChannelState(
          walletClient,
          resizeInfo,
          chain.id,
        );

        // Submit Custody.resize() on-chain
        setStep('submitting_resize');
        // Build the preceding state proof — the initial state from create()
        // The adjudicator validates this state has valid signatures from both participants
        const precedingAllocations = initialAllocations
          || resizeInfo.state.allocations.map((a) => ({
            destination: a.destination as `0x${string}`,
            token: a.token as `0x${string}`,
            amount: 0n,
          }));

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
            // Proofs: preceding state (initial create state with original sigs)
            [{
              intent: 1, // INITIALIZE
              version: 0n,
              data: initialStateData,
              allocations: precedingAllocations,
              sigs: initialStateSigs,
            }],
          ],
        });
        await publicClient.waitForTransactionReceipt({ hash: resizeHash });

        // Refresh balances
        await refreshBalances();

        setStep('complete');
      } catch (err) {
        setStep('error');
        if (err instanceof Error) {
          setError(err.message);
        } else {
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
    balances,
    deposit,
    refreshBalances,
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
