import * as snarkjs from 'snarkjs';
import * as path from 'path';

const CIRCUIT_WASM = path.join(__dirname, '../../circuits/settlementMatch.wasm');
const ZKEY_PATH = path.join(__dirname, '../../circuits/settlementMatch_final.zkey');

export interface OrderDetailsForProof {
  orderId: string;        // bytes32 hex
  user: string;           // address hex
  sellToken: string;      // address hex
  buyToken: string;       // address hex
  sellAmount: string;     // uint256 decimal string
  minBuyAmount: string;   // uint256 decimal string
  expiresAt: number;      // Unix timestamp
}

export interface ProofResult {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
  publicSignals: string[];
}

export async function generateSettlementProof(
  seller: OrderDetailsForProof,
  buyer: OrderDetailsForProof,
  sellerCommitmentHash: string,  // from DB commitment_hash column
  buyerCommitmentHash: string,   // from DB commitment_hash column
  sellerFillAmount: string,
  buyerFillAmount: string,
  sellerSettledSoFar: string,
  buyerSettledSoFar: string,
  currentTimestamp: number
): Promise<ProofResult> {

  const input = {
    // Private inputs — seller
    sellerOrderId: BigInt(seller.orderId).toString(),
    sellerUser: BigInt(seller.user).toString(),
    sellerSellToken: BigInt(seller.sellToken).toString(),
    sellerBuyToken: BigInt(seller.buyToken).toString(),
    sellerSellAmount: seller.sellAmount,
    sellerMinBuyAmount: seller.minBuyAmount,
    sellerExpiresAt: seller.expiresAt.toString(),

    // Private inputs — buyer
    buyerOrderId: BigInt(buyer.orderId).toString(),
    buyerUser: BigInt(buyer.user).toString(),
    buyerSellToken: BigInt(buyer.sellToken).toString(),
    buyerBuyToken: BigInt(buyer.buyToken).toString(),
    buyerSellAmount: buyer.sellAmount,
    buyerMinBuyAmount: buyer.minBuyAmount,
    buyerExpiresAt: buyer.expiresAt.toString(),

    // Public inputs — use actual on-chain hashes
    sellerCommitmentHash: BigInt(sellerCommitmentHash).toString(),
    buyerCommitmentHash: BigInt(buyerCommitmentHash).toString(),
    sellerFillAmount,
    buyerFillAmount,
    sellerSettledSoFar,
    buyerSettledSoFar,
    currentTimestamp: currentTimestamp.toString(),
  };

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    input,
    CIRCUIT_WASM,
    ZKEY_PATH
  );

  // Convert proof to Solidity-compatible format
  // snarkjs outputs [x, y, z] for G1 points — Solidity needs [x, y]
  // snarkjs outputs [[x1,y1],[x2,y2],[1,0]] for G2 — Solidity needs [[x2,x1],[y2,y1]]
  // NOTE: b coordinates are REVERSED for the Solidity verifier
  return {
    a: [proof.pi_a[0], proof.pi_a[1]] as [string, string],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ] as [[string, string], [string, string]],
    c: [proof.pi_c[0], proof.pi_c[1]] as [string, string],
    publicSignals,
  };
}
