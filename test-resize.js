/**
 * Test script to trace the uint256 error with negative allocate_amount.
 * Tests each layer: SDK message creation, signer, response parsing, frontend encoding.
 */

const { createResizeChannelMessage, createECDSAMessageSigner, parseResizeChannelResponse } = require('./app/server/node_modules/@erc7824/nitrolite');
const { generatePrivateKey } = require('./app/server/node_modules/viem/accounts');
const { toHex, encodeAbiParameters, keccak256 } = require('./app/server/node_modules/viem');

async function main() {
  const privateKey = generatePrivateKey();
  const signer = createECDSAMessageSigner(privateKey);

  // ---- Test 1: SDK createResizeChannelMessage ----
  console.log('=== Test 1: SDK createResizeChannelMessage with negative allocate_amount ===');
  try {
    const msg = await createResizeChannelMessage(signer, {
      channel_id: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      resize_amount: BigInt(40000000000000),
      allocate_amount: BigInt(-40000000000000),
      funds_destination: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    console.log('SUCCESS - Message created (first 200 chars):', msg.substring(0, 200));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  // ---- Test 2: Simulate clearnode response with NEGATIVE allocation amount ----
  console.log('\n=== Test 2: Parse clearnode response with negative allocation ===');
  const mockNegativeResponse = JSON.stringify({
    res: [1, 'resize_channel', {
      channel_id: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      state: {
        intent: 2,
        version: 1,
        state_data: '0x',
        allocations: [
          {
            destination: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
            token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
            amount: '-40000000000000',  // NEGATIVE - this is what we suspect the clearnode returns
          },
          {
            destination: '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef',
            token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb',
            amount: '40000000000000',
          },
        ],
      },
      server_signature: '0x' + 'aa'.repeat(65),
    }, 1234567890],
    sig: ['0x' + 'bb'.repeat(65)],
  });

  try {
    const parsed = parseResizeChannelResponse(mockNegativeResponse);
    console.log('Parsed allocations:', JSON.stringify(parsed.params.state.allocations.map(a => ({
      dest: a.destination.substring(0, 10),
      amount: a.amount.toString(),
    }))));
    console.log('Amount type:', typeof parsed.params.state.allocations[0].amount);
  } catch (err) {
    console.error('Parse FAILED:', err.message);
  }

  // ---- Test 3: Frontend signChannelState simulation ----
  console.log('\n=== Test 3: Frontend encodeAbiParameters with negative allocation (signChannelState) ===');
  try {
    const channelId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const allocations = [
      { destination: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb', amount: '-40000000000000' },
      { destination: '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef', token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb', amount: '40000000000000' },
    ];

    const packedState = encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'tuple[]', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] },
      ],
      [
        channelId,
        2, // intent
        BigInt(1), // version
        '0x', // stateData
        allocations.map((a) => [a.destination, a.token, BigInt(a.amount)]),
      ],
    );
    console.log('SUCCESS:', packedState.substring(0, 100));
  } catch (err) {
    console.error('FAILED - This is the EXACT error the user sees:', err.message);
  }

  // ---- Test 4: Same but with NON-NEGATIVE allocations ----
  console.log('\n=== Test 4: Frontend encodeAbiParameters with NON-NEGATIVE allocation ===');
  try {
    const channelId = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
    const allocations = [
      { destination: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb', amount: '40000000000000' },
      { destination: '0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef', token: '0xDB9F293e3898c9E5536A3be1b0C56c89d2b32DEb', amount: '0' },
    ];

    const packedState = encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'bytes' },
        { type: 'tuple[]', components: [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }] },
      ],
      [
        channelId,
        2,
        BigInt(1),
        '0x',
        allocations.map((a) => [a.destination, a.token, BigInt(a.amount)]),
      ],
    );
    console.log('SUCCESS:', packedState.substring(0, 100));
  } catch (err) {
    console.error('FAILED:', err.message);
  }

  // ---- Test 5: Simulate TWO-STEP resize (both non-negative) ----
  console.log('\n=== Test 5: Two-step resize simulation ===');
  console.log('Step 1: resize_amount=+X, allocate_amount=0 → alloc (X, 0) → non-negative');
  console.log('Step 2: resize_amount=0, allocate_amount=-X → alloc (0, 0) → non-negative');
  console.log('Both steps produce non-negative allocations for on-chain encoding.');
}

main().catch(console.error);
