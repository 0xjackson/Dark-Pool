import { useState, useCallback } from 'react';
import { useAccount, usePublicClient, useWalletClient, useSignTypedData } from 'wagmi';
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
  const { signTypedDataAsync } = useSignTypedData();

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

        // Step 2: Create channel if needed
        if (!channel) {
          setStep('creating_channel');
          const channelInfo = await requestCreateChannel(address, custodyToken);

          // Sign the channel initial state with MetaMask (EIP-712)
          setStep('signing_channel_state');
          const userSig = await signChannelState(
            signTypedDataAsync,
            channelInfo,
            CUSTODY_ADDRESS,
            chain.id,
          );

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
                data: (channelInfo.state.stateData || '0x') as `0x${string}`,
                allocations: channelInfo.state.allocations.map((a) => ({
                  destination: a.destination as `0x${string}`,
                  token: a.token as `0x${string}`,
                  amount: BigInt(a.amount),
                })),
                sigs: [userSig, channelInfo.serverSignature as `0x${string}`],
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
        setStep('requesting_resize');
        const resizeInfo = await requestResizeChannel(
          address,
          channel.channelId,
          rawAmount.toString(),
          '0',
        );

        // Sign the resize state
        setStep('signing_resize_state');
        const resizeSig = await signChannelState(
          signTypedDataAsync,
          resizeInfo,
          CUSTODY_ADDRESS,
          chain.id,
        );

        // Submit Custody.resize() on-chain
        setStep('submitting_resize');
        // Build the preceding state as proof (version - 1)
        // Only the user (index 0) allocation changes by +rawAmount; broker (index 1) stays at 0
        const precedingAllocations = resizeInfo.state.allocations.map((a, i) => ({
          destination: a.destination as `0x${string}`,
          token: a.token as `0x${string}`,
          amount: i === 0 ? BigInt(a.amount) - rawAmount : BigInt(a.amount),
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
            // Proofs: preceding state (the state before resize)
            [{
              intent: 1, // INITIALIZE or previous intent
              version: BigInt(resizeInfo.state.version - 1),
              data: '0x' as `0x${string}`,
              allocations: precedingAllocations,
              sigs: [],
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
    [address, isConnected, chain, walletClient, publicClient, signTypedDataAsync, refreshBalances]
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
 * Sign a channel state using EIP-712 via MetaMask.
 * Matches the Custody contract's EIP-712 domain ("Nitrolite:Custody", "0.3.0")
 * and AllowStateHash type from Types.sol.
 */
async function signChannelState(
  signTypedDataAsync: (args: any) => Promise<`0x${string}`>,
  channelInfo: ChannelInfo,
  custodyAddress: `0x${string}`,
  chainId: number,
): Promise<`0x${string}`> {
  // Compute channelId from channel params — must include chainId to match Utils.getChannelId()
  const channelEncoded = encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    [
      channelInfo.channel.participants.map((p) => p as `0x${string}`),
      channelInfo.channel.adjudicator as `0x${string}`,
      BigInt(channelInfo.channel.challenge),
      BigInt(channelInfo.channel.nonce),
      BigInt(chainId),
    ],
  );
  const channelId = keccak256(channelEncoded);

  const sig = await signTypedDataAsync({
    domain: {
      name: 'Nitrolite:Custody',
      version: '0.3.0',
      chainId,
      verifyingContract: custodyAddress,
    },
    types: {
      AllowStateHash: [
        { name: 'channelId', type: 'bytes32' },
        { name: 'intent', type: 'uint8' },
        { name: 'version', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'allocations', type: 'Allocation[]' },
      ],
      Allocation: [
        { name: 'destination', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
    },
    primaryType: 'AllowStateHash',
    message: {
      channelId,
      intent: channelInfo.state.intent,
      version: BigInt(channelInfo.state.version),
      data: (channelInfo.state.stateData || '0x') as `0x${string}`,
      allocations: channelInfo.state.allocations.map((a) => ({
        destination: a.destination as `0x${string}`,
        token: a.token as `0x${string}`,
        amount: BigInt(a.amount),
      })),
    },
  });

  return sig;
}
