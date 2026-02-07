#!/bin/bash
set -e

CIRCUIT=settlementMatch
BUILD_DIR=build
PTAU=$BUILD_DIR/pot15.ptau
SNARKJS=~/.npm-global/bin/snarkjs

echo "=== Compiling circuit ==="
circom $CIRCUIT.circom --r1cs --wasm --sym -o $BUILD_DIR

echo "=== Circuit info ==="
$SNARKJS r1cs info $BUILD_DIR/$CIRCUIT.r1cs

echo "=== Generating zkey (Groth16 setup) ==="
$SNARKJS groth16 setup $BUILD_DIR/$CIRCUIT.r1cs $PTAU $BUILD_DIR/${CIRCUIT}_0000.zkey

echo "=== Contributing to phase 2 ceremony ==="
$SNARKJS zkey contribute $BUILD_DIR/${CIRCUIT}_0000.zkey $BUILD_DIR/${CIRCUIT}_final.zkey \
  --name="dark-pool contribution" -v -e="$(head -c 64 /dev/urandom | xxd -p)"

echo "=== Exporting verification key ==="
$SNARKJS zkey export verificationkey $BUILD_DIR/${CIRCUIT}_final.zkey $BUILD_DIR/verification_key.json

echo "=== Generating Solidity verifier ==="
$SNARKJS zkey export solidityverifier $BUILD_DIR/${CIRCUIT}_final.zkey $BUILD_DIR/Groth16Verifier.sol

echo "=== Copying verifier to contracts ==="
cp $BUILD_DIR/Groth16Verifier.sol ../contracts/src/Groth16Verifier.sol

echo "=== Copying WASM + zkey to backend ==="
mkdir -p ../app/server/circuits
cp $BUILD_DIR/${CIRCUIT}_js/${CIRCUIT}.wasm ../app/server/circuits/
cp $BUILD_DIR/${CIRCUIT}_final.zkey ../app/server/circuits/

echo "=== Done ==="
echo "Artifacts:"
echo "  Solidity verifier: ../contracts/src/Groth16Verifier.sol"
echo "  Circuit WASM:      ../app/server/circuits/$CIRCUIT.wasm"
echo "  Proving key:       ../app/server/circuits/${CIRCUIT}_final.zkey"
