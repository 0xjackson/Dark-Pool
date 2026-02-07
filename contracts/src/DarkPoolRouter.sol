// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

//  ____             _      ____            _
// |  _ \  __ _ _ __| | __ |  _ \ ___   ___ | |
// | | | |/ _` | '__| |/ / | |_) / _ \ / _ \| |
// | |_| | (_| | |  |   <  |  __/ (_) | (_) | |
// |____/ \__,_|_|  |_|\_\ |_|   \___/ \___/|_|
//
//  ____             _
// |  _ \ ___  _   _| |_ ___ _ __
// | |_) / _ \| | | | __/ _ \ '__|
// |  _ < (_) | |_| | ||  __/ |
// |_| \_\___/ \__,_|\__\___|_|
//
// Commit-reveal order router for private P2P trading
// Settlement via Yellow Network App Sessions

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IYellowCustody.sol";
import {IZKVerifier} from "./interfaces/IZKVerifier.sol";
import {PoseidonT6} from "poseidon-solidity/PoseidonT6.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

contract DarkPoolRouter {
    using SafeERC20 for IERC20;

    // ============ CONSTANTS ============

    /// @notice BN128 scalar field modulus — all ZK circuit inputs must be less than this value.
    /// Poseidon hashes are field elements by construction (always < this).
    /// orderId must be masked to 253 bits by the frontend.
    /// Practical ERC-20 amounts (< 2^128) always fit.
    uint256 public constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    // ============ STATE ============

    IYellowCustody public immutable custody;
    address public immutable engine;
    IZKVerifier public immutable zkVerifier;

    mapping(bytes32 => Commitment) public commitments;

    // Removed "Settling" status. With partial fills, orders stay Active
    // until explicitly marked Settled via markFullySettled. Each partial fill
    // increments settledAmount; the off-chain matches table tracks per-match state.
    enum Status {
        None,
        Active,
        Settled,
        Cancelled
    }

    // Added settledAmount for partial fill tracking.
    // An order can be partially filled across multiple matches.
    // settledAmount tracks the cumulative amount settled so far.
    struct Commitment {
        address user;
        bytes32 orderHash;
        uint256 timestamp;
        uint256 settledAmount;
        Status status;
    }

    struct OrderDetails {
        bytes32 orderId;
        address user;
        address sellToken;
        address buyToken;
        uint256 sellAmount;
        uint256 minBuyAmount;
        uint256 expiresAt;
    }

    // ============ EVENTS ============

    event OrderCommitted(bytes32 indexed orderId, address indexed user, bytes32 orderHash);
    // OrdersSettling is emitted per match (pair of orders being settled).
    event OrdersSettling(bytes32 indexed sellerOrderId, bytes32 indexed buyerOrderId);
    // Per-order settlement event. Two sides of a match
    // may reach full settlement at different times with partial fills.
    event OrderSettled(bytes32 indexed orderId);
    event OrderCancelled(bytes32 indexed orderId);

    // ============ CONSTRUCTOR ============

    constructor(address _custody, address _engine, address _zkVerifier) {
        custody = IYellowCustody(_custody);
        engine = _engine;
        zkVerifier = IZKVerifier(_zkVerifier);
    }

    // ============ INTERNAL ============

    /// @notice Compute nested Poseidon hash of order details.
    /// Uses PoseidonT6(5 inputs) → PoseidonT4(3 inputs) because poseidon-solidity
    /// ships T2-T6 only — no T8 for 7 inputs.
    /// h1 = Poseidon(orderId, user, sellToken, buyToken, sellAmount)
    /// orderHash = Poseidon(h1, minBuyAmount, expiresAt)
    /// Matches frontend circomlibjs computation with same nested structure.
    function _computeOrderHash(OrderDetails calldata o) internal pure returns (bytes32) {
        uint256 h1 = PoseidonT6.hash(
            [
                uint256(o.orderId),
                uint256(uint160(o.user)),
                uint256(uint160(o.sellToken)),
                uint256(uint160(o.buyToken)),
                o.sellAmount
            ]
        );
        return bytes32(PoseidonT4.hash([h1, o.minBuyAmount, o.expiresAt]));
    }

    // ============ USER FUNCTIONS ============

    /// @notice Deposit tokens to Yellow and commit order hash (one transaction)
    function depositAndCommit(address token, uint256 depositAmount, bytes32 orderId, bytes32 orderHash) external {
        require(commitments[orderId].status == Status.None, "Order exists");

        // Defensive: ensure orderId and orderHash fit in BN128 scalar field for ZK compatibility.
        // Poseidon hashes are field elements by construction (always fit).
        // orderId must be masked to 253 bits by the frontend.
        require(uint256(orderId) < SNARK_SCALAR_FIELD, "orderId exceeds field");
        require(uint256(orderHash) < SNARK_SCALAR_FIELD, "orderHash exceeds field");

        // Pull tokens from user
        IERC20(token).safeTransferFrom(msg.sender, address(this), depositAmount);

        // Deposit to Yellow Custody — credits USER's unified balance (not Router's)
        IERC20(token).approve(address(custody), depositAmount);
        custody.deposit(msg.sender, token, depositAmount);

        // Store commitment (settledAmount starts at 0)
        commitments[orderId] = Commitment({
            user: msg.sender,
            orderHash: orderHash,
            timestamp: block.timestamp,
            settledAmount: 0,
            status: Status.Active
        });

        emit OrderCommitted(orderId, msg.sender, orderHash);
    }

    /// @notice Commit order hash only (user already has Yellow balance)
    function commitOnly(bytes32 orderId, bytes32 orderHash) external {
        require(commitments[orderId].status == Status.None, "Order exists");
        require(uint256(orderId) < SNARK_SCALAR_FIELD, "orderId exceeds field");
        require(uint256(orderHash) < SNARK_SCALAR_FIELD, "orderHash exceeds field");

        commitments[orderId] = Commitment({
            user: msg.sender,
            orderHash: orderHash,
            timestamp: block.timestamp,
            settledAmount: 0,
            status: Status.Active
        });

        emit OrderCommitted(orderId, msg.sender, orderHash);
    }

    /// @notice Cancel an active order (allowed even if partially filled — cancels unfilled remainder)
    function cancel(bytes32 orderId) external {
        Commitment storage c = commitments[orderId];
        require(c.user == msg.sender, "Not your order");
        require(c.status == Status.Active, "Cannot cancel");

        c.status = Status.Cancelled;

        emit OrderCancelled(orderId);
    }

    // ============ ENGINE FUNCTIONS ============

    /// @notice Verify order details and settle a partial or full fill (fallback path — reveals order details).
    /// Production path uses proveAndSettle with ZK proofs (added later).
    ///
    /// Changes from original:
    /// - Added sellerFillAmount and buyerFillAmount parameters for partial fills
    /// - Uses nested Poseidon hash (PoseidonT6 → PoseidonT4) instead of keccak256
    /// - Proportional slippage check (rate-based, not total-based)
    /// - Increments settledAmount instead of setting status to Settling
    /// - Orders stay Active (not Settling) — can receive more partial fills
    function revealAndSettle(
        bytes32 sellerOrderId,
        bytes32 buyerOrderId,
        OrderDetails calldata seller,
        OrderDetails calldata buyer,
        uint256 sellerFillAmount,
        uint256 buyerFillAmount
    ) external {
        require(msg.sender == engine, "Only engine");

        Commitment storage sellerC = commitments[sellerOrderId];
        Commitment storage buyerC = commitments[buyerOrderId];

        // Verify both active
        require(sellerC.status == Status.Active, "Seller not active");
        require(buyerC.status == Status.Active, "Buyer not active");

        // Verify Poseidon hashes match on-chain commitment
        require(_computeOrderHash(seller) == sellerC.orderHash, "Seller hash mismatch");
        require(_computeOrderHash(buyer) == buyerC.orderHash, "Buyer hash mismatch");

        // Verify not expired
        require(block.timestamp < seller.expiresAt, "Seller expired");
        require(block.timestamp < buyer.expiresAt, "Buyer expired");

        // Verify tokens match cross-wise
        require(seller.sellToken == buyer.buyToken, "Token mismatch");
        require(seller.buyToken == buyer.sellToken, "Token mismatch");

        // Verify fill amounts are positive
        require(sellerFillAmount > 0, "Zero seller fill");
        require(buyerFillAmount > 0, "Zero buyer fill");

        // Verify fill amounts don't exceed remaining (prevents overfilling)
        require(sellerFillAmount <= seller.sellAmount - sellerC.settledAmount, "Seller overfill");
        require(buyerFillAmount <= buyer.sellAmount - buyerC.settledAmount, "Buyer overfill");

        // Proportional slippage check (rate-based, not total-based).
        // For seller: the rate they receive (buyerFillAmount/sellerFillAmount) must be
        // at least as good as their minimum (minBuyAmount/sellAmount).
        // Rearranged to avoid division:
        //   buyerFillAmount / sellerFillAmount >= seller.minBuyAmount / seller.sellAmount
        //   buyerFillAmount * seller.sellAmount >= sellerFillAmount * seller.minBuyAmount
        require(buyerFillAmount * seller.sellAmount >= sellerFillAmount * seller.minBuyAmount, "Seller slippage");
        require(sellerFillAmount * buyer.sellAmount >= buyerFillAmount * buyer.minBuyAmount, "Buyer slippage");

        // Update settled amounts (order stays Active for more partial fills)
        sellerC.settledAmount += sellerFillAmount;
        buyerC.settledAmount += buyerFillAmount;

        emit OrdersSettling(sellerOrderId, buyerOrderId);
    }

    /// @notice Settle a match using a ZK proof — order details stay private.
    /// @dev The proof verifies: hash correctness, token match, expiry, no overfill, slippage.
    ///      The contract reads commitment hashes + settledAmounts from storage and passes
    ///      them as public inputs. This prevents replay (settledAmount changes after each call,
    ///      making old proofs invalid).
    function proveAndSettle(
        bytes32 sellerOrderId,
        bytes32 buyerOrderId,
        uint256 sellerFillAmount,
        uint256 buyerFillAmount,
        uint256[2] calldata a,
        uint256[2][2] calldata b,
        uint256[2] calldata c
    ) external {
        require(msg.sender == engine, "Only engine");

        Commitment storage sellerC = commitments[sellerOrderId];
        Commitment storage buyerC = commitments[buyerOrderId];

        require(sellerC.status == Status.Active, "Seller not active");
        require(buyerC.status == Status.Active, "Buyer not active");
        require(sellerFillAmount > 0, "Zero seller fill");
        require(buyerFillAmount > 0, "Zero buyer fill");

        // Build public inputs array — must match circuit's public signal order exactly
        uint256[7] memory pubInputs = [
            uint256(sellerC.orderHash),   // [0] sellerCommitmentHash
            uint256(buyerC.orderHash),    // [1] buyerCommitmentHash
            sellerFillAmount,             // [2] sellerFillAmount
            buyerFillAmount,              // [3] buyerFillAmount
            sellerC.settledAmount,        // [4] sellerSettledSoFar
            buyerC.settledAmount,         // [5] buyerSettledSoFar
            block.timestamp               // [6] currentTimestamp
        ];

        require(zkVerifier.verifyProof(a, b, c, pubInputs), "Invalid proof");

        // Update settled amounts (order stays Active for more partial fills)
        sellerC.settledAmount += sellerFillAmount;
        buyerC.settledAmount += buyerFillAmount;

        emit OrdersSettling(sellerOrderId, buyerOrderId);
    }

    /// @notice Mark an order as fully settled (called per-order after Yellow App Session completes).
    /// Per-order (not per-pair) because with partial fills, two sides may complete at different times.
    function markFullySettled(bytes32 orderId) external {
        require(msg.sender == engine, "Only engine");
        require(commitments[orderId].status == Status.Active, "Not active");

        commitments[orderId].status = Status.Settled;

        emit OrderSettled(orderId);
    }
}
