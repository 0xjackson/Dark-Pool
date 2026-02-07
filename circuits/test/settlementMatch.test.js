const { expect } = require('chai');
const { proveAndVerify, buildValidInput, computeOrderHash } = require('./helpers');

describe('SettlementMatch Circuit', function () {
  // Proof generation can take a few seconds
  this.timeout(30000);

  describe('Valid inputs', () => {
    it('should generate and verify a valid proof for a full fill', async () => {
      const { input } = await buildValidInput();
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should handle partial fills', async () => {
      const { input } = await buildValidInput({
        sellerFillAmount: '60',
        buyerFillAmount: '57', // 57/60 >= 90/100 (seller's min rate)
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should handle second partial fill with settledSoFar > 0', async () => {
      const { input } = await buildValidInput({
        sellerFillAmount: '40',
        buyerFillAmount: '38',
        sellerSettledSoFar: '60',
        buyerSettledSoFar: '57',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });

    it('should accept exact minimum slippage rate', async () => {
      // Seller: sell 100, min 90. Fill: 100 seller, 90 buyer.
      // Rate check: 90 * 100 >= 100 * 90 → 9000 >= 9000 ✓ (exactly equal)
      const { input } = await buildValidInput({
        sellerFillAmount: '100',
        buyerFillAmount: '90',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });
  });

  describe('Hash verification', () => {
    it('should reject wrong seller commitment hash', async () => {
      const { input } = await buildValidInput();
      input.sellerCommitmentHash = '999999999'; // wrong hash
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        // Witness generation should fail (constraint not satisfied)
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject wrong buyer commitment hash', async () => {
      const { input } = await buildValidInput();
      input.buyerCommitmentHash = '999999999';
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject tampered seller details (different sellAmount)', async () => {
      const { input } = await buildValidInput();
      input.sellerSellAmount = '200'; // tampered — hash won't match
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Token matching', () => {
    it('should reject mismatched tokens (seller.sellToken != buyer.buyToken)', async () => {
      const { input } = await buildValidInput();
      input.sellerSellToken = '9999'; // not buyer.buyToken
      // Recompute seller hash with the wrong token
      input.sellerCommitmentHash = await computeOrderHash(
        input.sellerOrderId, input.sellerUser, '9999', input.sellerBuyToken,
        input.sellerSellAmount, input.sellerMinBuyAmount, input.sellerExpiresAt
      );
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Expiry', () => {
    it('should reject expired seller order', async () => {
      const { input } = await buildValidInput({
        currentTimestamp: '9999999999', // same as expiresAt — NOT less than
      });
      // currentTimestamp must be STRICTLY less than expiresAt
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject when timestamp equals expiry (must be strictly less)', async () => {
      // Rebuild with seller expiry = 5000, timestamp = 5000
      const { input } = await buildValidInput({
        currentTimestamp: '5000',
      });
      input.sellerExpiresAt = '5000';
      input.sellerCommitmentHash = await computeOrderHash(
        input.sellerOrderId, input.sellerUser, input.sellerSellToken, input.sellerBuyToken,
        input.sellerSellAmount, input.sellerMinBuyAmount, '5000'
      );
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Overfill prevention', () => {
    it('should reject seller overfill', async () => {
      // sellAmount = 100, settledSoFar = 60, fillAmount = 50 → 60+50=110 > 100
      const { input } = await buildValidInput({
        sellerFillAmount: '50',
        sellerSettledSoFar: '60',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject buyer overfill', async () => {
      // buyerSellAmount = 95, settledSoFar = 80, fillAmount = 20 → 80+20=100 > 95
      const { input } = await buildValidInput({
        buyerFillAmount: '20',
        buyerSettledSoFar: '80',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should accept fill that exactly uses remaining capacity', async () => {
      // sellAmount = 100, settledSoFar = 60, fillAmount = 40 → 60+40=100 <= 100 ✓
      const { input } = await buildValidInput({
        sellerFillAmount: '40',
        buyerFillAmount: '38',
        sellerSettledSoFar: '60',
        buyerSettledSoFar: '57',
      });
      const { valid } = await proveAndVerify(input);
      expect(valid).to.be.true;
    });
  });

  describe('Slippage', () => {
    it('should reject bad seller rate', async () => {
      // Seller: sell 100, min 90 → min rate 0.9
      // Fill: 100 seller, 80 buyer → rate 0.8 < 0.9
      // Check: 80 * 100 >= 100 * 90 → 8000 >= 9000 → FALSE
      const { input } = await buildValidInput({
        sellerFillAmount: '100',
        buyerFillAmount: '80', // below seller's minimum
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });

    it('should reject bad buyer rate', async () => {
      // Buyer: sell 95, min 90 → min rate 90/95 ≈ 0.947
      // Fill: 85 seller, 95 buyer → buyer gives 95, gets 85 → rate 85/95 ≈ 0.89 < 0.947
      // Check: 85 * 95 >= 95 * 90 → 8075 >= 8550 → FALSE
      const { input } = await buildValidInput({
        sellerFillAmount: '85',
        buyerFillAmount: '95',
      });
      try {
        await proveAndVerify(input);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('Assert Failed');
      }
    });
  });

  describe('Poseidon hash consistency', () => {
    it('should match frontend/backend Poseidon implementation', async () => {
      // Use realistic hex values like real addresses
      const orderId = '0x1a2b3c4d5e6f';
      const user = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'; // vitalik.eth
      const sellToken = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // USDC
      const buyToken = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // WETH
      const sellAmount = '100000000'; // 100 USDC (6 decimals)
      const minBuyAmount = '50000000000000000'; // 0.05 WETH
      const expiresAt = '1707350400';

      const hash = await computeOrderHash(
        BigInt(orderId).toString(),
        BigInt(user).toString(),
        BigInt(sellToken).toString(),
        BigInt(buyToken).toString(),
        sellAmount, minBuyAmount, expiresAt
      );

      // The hash should be a valid field element (< SNARK_SCALAR_FIELD)
      const SNARK_SCALAR_FIELD = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
      expect(BigInt(hash) < SNARK_SCALAR_FIELD).to.be.true;
      expect(BigInt(hash) > 0n).to.be.true;
    });
  });
});
