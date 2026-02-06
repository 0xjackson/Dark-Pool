// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IYellowCustody.sol";

contract DarkPoolRouter {
    using SafeERC20 for IERC20;

    // ============ STATE ============

    IYellowCustody public immutable custody;
    address public immutable engine;

    mapping(bytes32 => Commitment) public commitments;

    enum Status {
        None,
        Active,
        Settling,
        Settled,
        Cancelled
    }

    struct Commitment {
        address user;
        bytes32 orderHash;
        uint256 timestamp;
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
    event OrdersSettling(bytes32 indexed sellerOrderId, bytes32 indexed buyerOrderId);
    event OrdersSettled(bytes32 indexed sellerOrderId, bytes32 indexed buyerOrderId);
    event OrderCancelled(bytes32 indexed orderId);

    // ============ CONSTRUCTOR ============

    constructor(address _custody, address _engine) {
        custody = IYellowCustody(_custody);
        engine = _engine;
    }

    // ============ USER FUNCTIONS ============

    /// @notice Deposit tokens to Yellow and commit order hash (one transaction)
    function depositAndCommit(address token, uint256 depositAmount, bytes32 orderId, bytes32 orderHash) external {
        require(commitments[orderId].status == Status.None, "Order exists");

        // Pull tokens from user
        IERC20(token).safeTransferFrom(msg.sender, address(this), depositAmount);

        // Deposit to Yellow Custody
        IERC20(token).approve(address(custody), depositAmount);
        custody.deposit(token, depositAmount);

        // Store commitment
        commitments[orderId] =
            Commitment({user: msg.sender, orderHash: orderHash, timestamp: block.timestamp, status: Status.Active});

        emit OrderCommitted(orderId, msg.sender, orderHash);
    }

    /// @notice Commit order hash only (user already has Yellow balance)
    function commitOnly(bytes32 orderId, bytes32 orderHash) external {
        require(commitments[orderId].status == Status.None, "Order exists");

        commitments[orderId] =
            Commitment({user: msg.sender, orderHash: orderHash, timestamp: block.timestamp, status: Status.Active});

        emit OrderCommitted(orderId, msg.sender, orderHash);
    }

    /// @notice Cancel an active order
    function cancel(bytes32 orderId) external {
        Commitment storage c = commitments[orderId];
        require(c.user == msg.sender, "Not your order");
        require(c.status == Status.Active, "Cannot cancel");

        c.status = Status.Cancelled;

        emit OrderCancelled(orderId);
    }

    // ============ ENGINE FUNCTIONS ============

    /// @notice Reveal orders and verify match (called before Yellow settlement)
    function revealAndSettle(
        bytes32 sellerOrderId,
        bytes32 buyerOrderId,
        OrderDetails calldata seller,
        OrderDetails calldata buyer
    ) external {
        require(msg.sender == engine, "Only engine");

        Commitment storage sellerC = commitments[sellerOrderId];
        Commitment storage buyerC = commitments[buyerOrderId];

        // Verify both active
        require(sellerC.status == Status.Active, "Seller not active");
        require(buyerC.status == Status.Active, "Buyer not active");

        // Verify hashes match
        require(keccak256(abi.encode(seller)) == sellerC.orderHash, "Seller hash mismatch");
        require(keccak256(abi.encode(buyer)) == buyerC.orderHash, "Buyer hash mismatch");

        // Verify not expired
        require(block.timestamp < seller.expiresAt, "Seller expired");
        require(block.timestamp < buyer.expiresAt, "Buyer expired");

        // Verify tokens match
        require(seller.sellToken == buyer.buyToken, "Token mismatch");
        require(seller.buyToken == buyer.sellToken, "Token mismatch");

        // Verify constraints (slippage protection)
        require(buyer.sellAmount >= seller.minBuyAmount, "Seller min not met");
        require(seller.sellAmount >= buyer.minBuyAmount, "Buyer min not met");

        // Mark as settling
        sellerC.status = Status.Settling;
        buyerC.status = Status.Settling;

        emit OrdersSettling(sellerOrderId, buyerOrderId);
    }

    /// @notice Mark orders as fully settled (called after Yellow settlement)
    function markFullySettled(bytes32 sellerOrderId, bytes32 buyerOrderId) external {
        require(msg.sender == engine, "Only engine");
        require(commitments[sellerOrderId].status == Status.Settling, "Not settling");
        require(commitments[buyerOrderId].status == Status.Settling, "Not settling");

        commitments[sellerOrderId].status = Status.Settled;
        commitments[buyerOrderId].status = Status.Settled;

        emit OrdersSettled(sellerOrderId, buyerOrderId);
    }

}
