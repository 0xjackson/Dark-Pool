// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {DarkPoolRouter} from "../src/DarkPoolRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockYellowCustody} from "./mocks/MockYellowCustody.sol";
import {PoseidonT6} from "poseidon-solidity/PoseidonT6.sol";
import {PoseidonT4} from "poseidon-solidity/PoseidonT4.sol";

contract DarkPoolRouterTest is Test {
    DarkPoolRouter public router;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    MockYellowCustody public custody;

    address alice = address(0xA);
    address bob = address(0xB);
    address charlie = address(0xC);
    address engine = address(0xE);

    // orderId constants — masked to 253 bits for BN128 field compatibility
    uint256 constant FIELD_MASK = (uint256(1) << 253) - 1;
    bytes32 SELLER_ORDER_ID = bytes32(uint256(keccak256("seller-order-1")) & FIELD_MASK);
    bytes32 BUYER_ORDER_ID = bytes32(uint256(keccak256("buyer-order-1")) & FIELD_MASK);
    bytes32 BUYER2_ORDER_ID = bytes32(uint256(keccak256("buyer-order-2")) & FIELD_MASK);

    function setUp() public {
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        custody = new MockYellowCustody();
        router = new DarkPoolRouter(address(custody), engine);

        tokenA.mint(alice, 1000 ether);
        tokenB.mint(bob, 1000 ether);
        tokenB.mint(charlie, 1000 ether);

        vm.prank(alice);
        tokenA.approve(address(router), type(uint256).max);
        vm.prank(bob);
        tokenB.approve(address(router), type(uint256).max);
        vm.prank(charlie);
        tokenB.approve(address(router), type(uint256).max);
    }

    // ============ HELPERS ============

    /// @notice Compute nested Poseidon hash matching the contract's _computeOrderHash
    function _poseidonHash(DarkPoolRouter.OrderDetails memory o) internal pure returns (bytes32) {
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

    function _makeSellerOrder(uint256 sellAmount, uint256 minBuyAmount, uint256 expiresAt)
        internal
        view
        returns (DarkPoolRouter.OrderDetails memory)
    {
        return DarkPoolRouter.OrderDetails({
            orderId: SELLER_ORDER_ID,
            user: alice,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: sellAmount,
            minBuyAmount: minBuyAmount,
            expiresAt: expiresAt
        });
    }

    function _makeBuyerOrder(
        bytes32 orderId,
        address buyer,
        uint256 sellAmount,
        uint256 minBuyAmount,
        uint256 expiresAt
    ) internal view returns (DarkPoolRouter.OrderDetails memory) {
        return DarkPoolRouter.OrderDetails({
            orderId: orderId,
            user: buyer,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: sellAmount,
            minBuyAmount: minBuyAmount,
            expiresAt: expiresAt
        });
    }

    function _commitOrder(address user, address token, uint256 depositAmount, DarkPoolRouter.OrderDetails memory order)
        internal
    {
        // Compute hash before prank — PoseidonT6/T4 delegatecalls would consume the prank
        bytes32 hash = _poseidonHash(order);
        vm.prank(user);
        router.depositAndCommit(token, depositAmount, order.orderId, hash);
    }

    // ============ HAPPY PATH: FULL FILL ============

    function test_FullLifecycle() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);

        // Commit both
        _commitOrder(alice, address(tokenA), 100 ether, seller);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        // Verify commitment state
        (address user,,, uint256 settledAmount, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(user, alice);
        assertEq(settledAmount, 0);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
        assertEq(custody.deposits(alice, address(tokenA)), 100 ether);

        // Reveal + settle (full fill: seller fills 100, buyer fills 95)
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);

        // After settlement: still Active (not Settling), settledAmount updated
        (,,, settledAmount, status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
        assertEq(settledAmount, 100 ether);

        // Finalize each order separately (per-order, not per-pair)
        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID);
        (,,,, status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settled));

        vm.prank(engine);
        router.markFullySettled(BUYER_ORDER_ID);
        (,,,, status) = router.commitments(BUYER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settled));
    }

    function test_CommitOnlyFlow() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);

        // Alice uses commitOnly (no deposit)
        bytes32 sellerHash = _poseidonHash(seller);
        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, sellerHash);

        // Bob deposits + commits
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);

        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID);
        vm.prank(engine);
        router.markFullySettled(BUYER_ORDER_ID);

        (,,,, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settled));
    }

    // ============ PARTIAL FILLS ============

    function test_PartialFill_TwoMatches() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Alice sells 100 TKA for >= 90 TKB
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        // Bob buys 60 TKA (sells 57 TKB for >= 54 TKA)
        DarkPoolRouter.OrderDetails memory buyer1 = _makeBuyerOrder(BUYER_ORDER_ID, bob, 57 ether, 54 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 57 ether, buyer1);

        // Match 1: settle 60/57 (seller gives 60 TKA, buyer gives 57 TKB)
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer1, 60 ether, 57 ether);

        // Seller partially filled: settledAmount = 60, still Active
        (,,, uint256 sellerSettled, DarkPoolRouter.Status sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(sellerSettled, 60 ether);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Active));

        // Buyer1 fully filled: settledAmount = 57
        (,,, uint256 buyer1Settled,) = router.commitments(BUYER_ORDER_ID);
        assertEq(buyer1Settled, 57 ether);

        // Charlie buys remaining 40 TKA (sells 38 TKB for >= 36 TKA)
        DarkPoolRouter.OrderDetails memory buyer2 =
            _makeBuyerOrder(BUYER2_ORDER_ID, charlie, 38 ether, 36 ether, expiresAt);
        _commitOrder(charlie, address(tokenB), 38 ether, buyer2);

        // Match 2: settle remaining 40/38
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER2_ORDER_ID, seller, buyer2, 40 ether, 38 ether);

        // Seller now fully filled: settledAmount = 100
        (,,, sellerSettled,) = router.commitments(SELLER_ORDER_ID);
        assertEq(sellerSettled, 100 ether);

        // Mark all fully settled
        vm.startPrank(engine);
        router.markFullySettled(SELLER_ORDER_ID);
        router.markFullySettled(BUYER_ORDER_ID);
        router.markFullySettled(BUYER2_ORDER_ID);
        vm.stopPrank();

        (,,,, sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settled));
    }

    // ============ PROPORTIONAL SLIPPAGE ============

    function test_ProportionalSlippage_ValidRate() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Seller: sell 100 TKA, want at least 90 TKB (rate: 0.9 TKB/TKA)
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        // Buyer: sell 95 TKB, want at least 90 TKA (rate: ~0.947 TKA/TKB)
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        // Partial fill: 50 TKA / 47.5 TKB. Rate = 0.95 TKB/TKA >= 0.9 minimum. Should pass.
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 50 ether, 47.5 ether);

        (,,, uint256 settled,) = router.commitments(SELLER_ORDER_ID);
        assertEq(settled, 50 ether);
    }

    function test_RevertProportionalSlippage_BadRate() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Seller: sell 100 TKA, want at least 90 TKB (rate: 0.9 TKB/TKA)
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        // Buyer: sell 95 TKB, want at least 90 TKA
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        // Bad rate: 50 TKA for only 40 TKB. Rate = 0.8 TKB/TKA < 0.9 minimum. Should revert.
        vm.prank(engine);
        vm.expectRevert("Seller slippage");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 50 ether, 40 ether);
    }

    // ============ OVERFILL PREVENTION ============

    function test_RevertOverfill() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        // First fill: 80 TKA
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 80 ether, 76 ether);

        // Second fill: try 30 TKA (only 20 remaining). Should revert.
        DarkPoolRouter.OrderDetails memory buyer2 =
            _makeBuyerOrder(BUYER2_ORDER_ID, charlie, 38 ether, 36 ether, expiresAt);
        _commitOrder(charlie, address(tokenB), 38 ether, buyer2);

        vm.prank(engine);
        vm.expectRevert("Seller overfill");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER2_ORDER_ID, seller, buyer2, 30 ether, 28.5 ether);
    }

    function test_RevertZeroFill() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.prank(engine);
        vm.expectRevert("Zero seller fill");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 0, 95 ether);
    }

    // ============ CANCEL ============

    function test_Cancel() public {
        vm.prank(alice);
        bytes32 oid = bytes32(uint256(1));
        bytes32 ohash = bytes32(uint256(2));
        router.commitOnly(oid, ohash);

        vm.prank(alice);
        router.cancel(oid);

        (,,,, DarkPoolRouter.Status status) = router.commitments(oid);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Cancelled));
    }

    function test_CancelPartiallyFilled() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 57 ether, 54 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 57 ether, buyer);

        // Partial fill
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 60 ether, 57 ether);

        // Cancel remainder — should succeed (order is still Active)
        vm.prank(alice);
        router.cancel(SELLER_ORDER_ID);

        (,,, uint256 settled, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Cancelled));
        assertEq(settled, 60 ether); // settled amount preserved

        // Can't settle further after cancel
        DarkPoolRouter.OrderDetails memory buyer2 =
            _makeBuyerOrder(BUYER2_ORDER_ID, charlie, 38 ether, 36 ether, expiresAt);
        _commitOrder(charlie, address(tokenB), 38 ether, buyer2);

        vm.prank(engine);
        vm.expectRevert("Seller not active");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER2_ORDER_ID, seller, buyer2, 40 ether, 38 ether);
    }

    function test_RevertCancelNotOwner() public {
        vm.prank(alice);
        router.commitOnly(bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(bob);
        vm.expectRevert("Not your order");
        router.cancel(bytes32(uint256(1)));
    }

    // ============ MARK FULLY SETTLED ============

    function test_MarkFullySettled_PerOrder() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);

        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);

        // Can mark seller as settled independently from buyer
        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID);

        (,,,, DarkPoolRouter.Status sellerStatus) = router.commitments(SELLER_ORDER_ID);
        (,,,, DarkPoolRouter.Status buyerStatus) = router.commitments(BUYER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settled));
        assertEq(uint8(buyerStatus), uint8(DarkPoolRouter.Status.Active)); // buyer not yet settled
    }

    function test_RevertMarkFullySettled_NotEngine() public {
        vm.prank(alice);
        router.commitOnly(bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(alice);
        vm.expectRevert("Only engine");
        router.markFullySettled(bytes32(uint256(1)));
    }

    function test_RevertMarkFullySettled_NotActive() public {
        vm.prank(alice);
        router.commitOnly(bytes32(uint256(1)), bytes32(uint256(2)));

        vm.prank(alice);
        router.cancel(bytes32(uint256(1)));

        vm.prank(engine);
        vm.expectRevert("Not active");
        router.markFullySettled(bytes32(uint256(1)));
    }

    // ============ ACCESS CONTROL ============

    function test_RevertOnlyEngine_RevealAndSettle() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.prank(alice);
        vm.expectRevert("Only engine");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);
    }

    // ============ HASH MISMATCH ============

    function test_RevertHashMismatch() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        // Tamper with seller details
        seller.sellAmount = 999 ether;

        vm.prank(engine);
        vm.expectRevert("Seller hash mismatch");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);
    }

    // ============ EXPIRY ============

    function test_RevertExpired() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.warp(expiresAt + 1);

        vm.prank(engine);
        vm.expectRevert("Seller expired");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);
    }

    // ============ REPLAY ============

    function test_RevertDoubleCommit() public {
        bytes32 oid = bytes32(uint256(1));
        bytes32 ohash = bytes32(uint256(2));
        vm.prank(alice);
        router.commitOnly(oid, ohash);

        vm.prank(alice);
        vm.expectRevert("Order exists");
        router.commitOnly(oid, ohash);
    }

    function test_RevertSettleCancelled() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(BUYER_ORDER_ID, bob, 95 ether, 90 ether, expiresAt);
        _commitOrder(alice, address(tokenA), 100 ether, seller);
        _commitOrder(bob, address(tokenB), 95 ether, buyer);

        vm.prank(alice);
        router.cancel(SELLER_ORDER_ID);

        vm.prank(engine);
        vm.expectRevert("Seller not active");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer, 100 ether, 95 ether);
    }

    // ============ FIELD BOUNDS ============

    function test_RevertOrderIdExceedsField() public {
        // orderId with top bits set — exceeds SNARK_SCALAR_FIELD
        bytes32 badId = bytes32(type(uint256).max);
        bytes32 goodHash = bytes32(uint256(1));

        vm.prank(alice);
        vm.expectRevert("orderId exceeds field");
        router.commitOnly(badId, goodHash);
    }

    function test_RevertOrderHashExceedsField() public {
        bytes32 goodId = bytes32(uint256(1));
        bytes32 badHash = bytes32(type(uint256).max);

        vm.prank(alice);
        vm.expectRevert("orderHash exceeds field");
        router.commitOnly(goodId, badHash);
    }
}
