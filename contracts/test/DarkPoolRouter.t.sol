// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {DarkPoolRouter} from "../src/DarkPoolRouter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockYellowCustody} from "./mocks/MockYellowCustody.sol";

contract DarkPoolRouterTest is Test {
    DarkPoolRouter public router;
    MockERC20 public tokenA;
    MockERC20 public tokenB;
    MockYellowCustody public custody;

    uint256 aliceKey = 0xa11ce;
    uint256 bobKey = 0xb0b;
    address alice;
    address bob;
    address engine = address(0xE);

    bytes32 constant SELLER_ORDER_ID = keccak256("seller-order-1");
    bytes32 constant BUYER_ORDER_ID = keccak256("buyer-order-1");

    bytes32 constant ORDER_TYPEHASH = keccak256(
        "Order(bytes32 orderId,address sellToken,address buyToken,uint256 sellAmount,uint256 minBuyAmount,uint256 expiresAt)"
    );

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);

        // Deploy mocks
        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        custody = new MockYellowCustody();

        // Deploy router
        router = new DarkPoolRouter(address(custody), engine);

        // Mint tokens
        tokenA.mint(alice, 1000 ether);
        tokenB.mint(bob, 1000 ether);

        // Approvals
        vm.prank(alice);
        tokenA.approve(address(router), type(uint256).max);
        vm.prank(bob);
        tokenB.approve(address(router), type(uint256).max);
    }

    // ============ HELPERS ============

    function _signOrder(
        uint256 privateKey,
        bytes32 orderId,
        address sellToken,
        address buyToken,
        uint256 sellAmount,
        uint256 minBuyAmount,
        uint256 expiresAt
    ) internal view returns (bytes memory) {
        bytes32 structHash =
            keccak256(abi.encode(ORDER_TYPEHASH, orderId, sellToken, buyToken, sellAmount, minBuyAmount, expiresAt));
        bytes32 digest = _getDigest(structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _getDigest(bytes32 structHash) internal view returns (bytes32) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DarkPool"),
                keccak256("1"),
                block.chainid,
                address(router)
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _makeSellerOrder(uint256 expiresAt) internal view returns (DarkPoolRouter.OrderDetails memory) {
        bytes memory sig =
            _signOrder(aliceKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 90 ether, expiresAt);
        return DarkPoolRouter.OrderDetails({
            orderId: SELLER_ORDER_ID,
            user: alice,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 100 ether,
            minBuyAmount: 90 ether,
            expiresAt: expiresAt,
            signature: sig
        });
    }

    function _makeBuyerOrder(uint256 expiresAt) internal view returns (DarkPoolRouter.OrderDetails memory) {
        bytes memory sig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenB), address(tokenA), 95 ether, 90 ether, expiresAt);
        return DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 95 ether,
            minBuyAmount: 90 ether,
            expiresAt: expiresAt,
            signature: sig
        });
    }

    function _commitSellerOrder(DarkPoolRouter.OrderDetails memory seller) internal {
        bytes32 sellerHash = keccak256(abi.encode(seller));
        vm.prank(alice);
        router.depositAndCommit(address(tokenA), 100 ether, SELLER_ORDER_ID, sellerHash);
    }

    function _commitBuyerOrder(DarkPoolRouter.OrderDetails memory buyer) internal {
        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, buyerHash);
    }

    // ============ HAPPY PATH ============

    function test_FullHappyPath() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Step 1: Commit
        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        // Verify commitments stored
        (address sellerUser,,, DarkPoolRouter.Status sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(sellerUser, alice);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Active));

        // Step 2: Reveal and settle
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        (,,, sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settling));

        // Step 3: Mark fully settled
        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);

        (,,, sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settled));
    }

    function test_DepositAndCommit() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        bytes32 sellerHash = keccak256(abi.encode(seller));

        uint256 aliceBefore = tokenA.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit DarkPoolRouter.OrderCommitted(SELLER_ORDER_ID, alice, sellerHash);
        router.depositAndCommit(address(tokenA), 100 ether, SELLER_ORDER_ID, sellerHash);

        // Alice's tokens moved
        assertEq(tokenA.balanceOf(alice), aliceBefore - 100 ether);

        // Custody received them
        assertEq(custody.deposits(address(router), address(tokenA)), 100 ether);

        // Commitment stored
        (address user, bytes32 hash, uint256 ts, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(user, alice);
        assertEq(hash, sellerHash);
        assertEq(ts, block.timestamp);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
    }

    // ============ COMMIT ONLY ============

    function test_CommitOnly() public {
        bytes32 orderId = keccak256("commit-only-order");
        bytes32 orderHash = keccak256("some-hash");

        vm.prank(alice);
        vm.expectEmit(true, true, false, true);
        emit DarkPoolRouter.OrderCommitted(orderId, alice, orderHash);
        router.commitOnly(orderId, orderHash);

        (address user, bytes32 hash,, DarkPoolRouter.Status status) = router.commitments(orderId);
        assertEq(user, alice);
        assertEq(hash, orderHash);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
    }

    function test_CommitOnlyFlow() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Seller uses commitOnly
        bytes32 sellerHash = keccak256(abi.encode(seller));
        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, sellerHash);

        // Buyer deposits and commits
        _commitBuyerOrder(buyer);

        // Engine settles
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);

        (,,, DarkPoolRouter.Status sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settled));
    }

    // ============ CANCEL ============

    function test_CancelOwnOrder() public {
        bytes32 orderId = keccak256("cancel-order");
        bytes32 orderHash = keccak256("hash");

        vm.prank(alice);
        router.commitOnly(orderId, orderHash);

        vm.prank(alice);
        vm.expectEmit(true, false, false, false);
        emit DarkPoolRouter.OrderCancelled(orderId);
        router.cancel(orderId);

        (,,, DarkPoolRouter.Status status) = router.commitments(orderId);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Cancelled));
    }

    function test_RevertCancelOtherOrder() public {
        bytes32 orderId = keccak256("cancel-other");
        bytes32 orderHash = keccak256("hash");

        vm.prank(alice);
        router.commitOnly(orderId, orderHash);

        vm.prank(bob);
        vm.expectRevert("Not your order");
        router.cancel(orderId);
    }

    function test_RevertCancelSettlingOrder() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        vm.prank(alice);
        vm.expectRevert("Cannot cancel");
        router.cancel(SELLER_ORDER_ID);
    }

    // ============ ACCESS CONTROL ============

    function test_RevertRevealAndSettleNotEngine() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(alice);
        vm.expectRevert("Only engine");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_RevertMarkFullySettledNotEngine() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        vm.prank(alice);
        vm.expectRevert("Only engine");
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);
    }

    // ============ SIGNATURE VERIFICATION ============

    function test_RevertInvalidSignature() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Tamper with seller signature — use bob's key to sign seller's order
        bytes memory wrongSig =
            _signOrder(bobKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 90 ether, expiresAt);
        seller.signature = wrongSig;

        // Recompute hash with tampered order
        bytes32 sellerHash = keccak256(abi.encode(seller));
        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, sellerHash);

        _commitBuyerOrder(buyer);

        vm.prank(engine);
        vm.expectRevert("Invalid seller signature");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ EXPIRY ============

    function test_RevertExpiredSellerOrder() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        // Warp past expiry
        vm.warp(expiresAt + 1);

        vm.prank(engine);
        vm.expectRevert("Seller expired");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_RevertExpiredBuyerOrder() public {
        uint256 sellerExpires = block.timestamp + 2 hours;
        uint256 buyerExpires = block.timestamp + 1 hours;

        // Seller with later expiry
        bytes memory sellerSig =
            _signOrder(aliceKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 90 ether, sellerExpires);
        DarkPoolRouter.OrderDetails memory seller = DarkPoolRouter.OrderDetails({
            orderId: SELLER_ORDER_ID,
            user: alice,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 100 ether,
            minBuyAmount: 90 ether,
            expiresAt: sellerExpires,
            signature: sellerSig
        });

        // Buyer with earlier expiry
        bytes memory buyerSig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenB), address(tokenA), 95 ether, 90 ether, buyerExpires);
        DarkPoolRouter.OrderDetails memory buyer = DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 95 ether,
            minBuyAmount: 90 ether,
            expiresAt: buyerExpires,
            signature: buyerSig
        });

        _commitSellerOrder(seller);

        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, buyerHash);

        // Warp past buyer expiry but before seller expiry
        vm.warp(buyerExpires + 1);

        vm.prank(engine);
        vm.expectRevert("Buyer expired");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ TOKEN MISMATCH ============

    function test_RevertTokenMismatch() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Both sellers sell tokenA (mismatch: buyer.buyToken != seller.sellToken because buyer buys tokenA too)
        MockERC20 tokenC = new MockERC20("Token C", "TKC");
        tokenC.mint(bob, 1000 ether);
        vm.prank(bob);
        tokenC.approve(address(router), type(uint256).max);

        // Seller: sell A, buy B
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);

        // Buyer: sell C, buy A (mismatch: seller.buyToken=B != buyer.sellToken=C)
        bytes memory buyerSig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenC), address(tokenA), 95 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenC),
            buyToken: address(tokenA),
            sellAmount: 95 ether,
            minBuyAmount: 90 ether,
            expiresAt: expiresAt,
            signature: buyerSig
        });

        _commitSellerOrder(seller);

        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenC), 95 ether, BUYER_ORDER_ID, buyerHash);

        vm.prank(engine);
        vm.expectRevert("Token mismatch");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ SLIPPAGE ============

    function test_RevertSlippageSellerMinNotMet() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Seller wants min 90 tokenB
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);

        // Buyer only selling 80 tokenB (below seller's min of 90)
        bytes memory buyerSig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenB), address(tokenA), 80 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 80 ether,
            minBuyAmount: 90 ether,
            expiresAt: expiresAt,
            signature: buyerSig
        });

        _commitSellerOrder(seller);

        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 80 ether, BUYER_ORDER_ID, buyerHash);

        vm.prank(engine);
        vm.expectRevert("Seller min not met");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_RevertSlippageBuyerMinNotMet() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Seller sells 100 tokenA
        // Buyer wants min 110 tokenA but seller only selling 100
        bytes memory sellerSig =
            _signOrder(aliceKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 90 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory seller = DarkPoolRouter.OrderDetails({
            orderId: SELLER_ORDER_ID,
            user: alice,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 100 ether,
            minBuyAmount: 90 ether,
            expiresAt: expiresAt,
            signature: sellerSig
        });

        bytes memory buyerSig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenB), address(tokenA), 95 ether, 110 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 95 ether,
            minBuyAmount: 110 ether,
            expiresAt: expiresAt,
            signature: buyerSig
        });

        bytes32 sellerHash = keccak256(abi.encode(seller));
        vm.prank(alice);
        router.depositAndCommit(address(tokenA), 100 ether, SELLER_ORDER_ID, sellerHash);

        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, buyerHash);

        vm.prank(engine);
        vm.expectRevert("Buyer min not met");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_SlippageExactMinPasses() public {
        uint256 expiresAt = block.timestamp + 1 hours;

        // Seller minBuyAmount = exactly buyer's sellAmount
        bytes memory sellerSig =
            _signOrder(aliceKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 95 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory seller = DarkPoolRouter.OrderDetails({
            orderId: SELLER_ORDER_ID,
            user: alice,
            sellToken: address(tokenA),
            buyToken: address(tokenB),
            sellAmount: 100 ether,
            minBuyAmount: 95 ether,
            expiresAt: expiresAt,
            signature: sellerSig
        });

        bytes memory buyerSig =
            _signOrder(bobKey, BUYER_ORDER_ID, address(tokenB), address(tokenA), 95 ether, 100 ether, expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = DarkPoolRouter.OrderDetails({
            orderId: BUYER_ORDER_ID,
            user: bob,
            sellToken: address(tokenB),
            buyToken: address(tokenA),
            sellAmount: 95 ether,
            minBuyAmount: 100 ether,
            expiresAt: expiresAt,
            signature: buyerSig
        });

        bytes32 sellerHash = keccak256(abi.encode(seller));
        vm.prank(alice);
        router.depositAndCommit(address(tokenA), 100 ether, SELLER_ORDER_ID, sellerHash);

        bytes32 buyerHash = keccak256(abi.encode(buyer));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, buyerHash);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        (,,, DarkPoolRouter.Status sellerStatus) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(sellerStatus), uint8(DarkPoolRouter.Status.Settling));
    }

    // ============ REPLAY PROTECTION ============

    function test_RevertDoubleCommit() public {
        bytes32 orderId = keccak256("replay-order");
        bytes32 orderHash = keccak256("hash");

        vm.prank(alice);
        router.commitOnly(orderId, orderHash);

        vm.prank(alice);
        vm.expectRevert("Order exists");
        router.commitOnly(orderId, orderHash);
    }

    function test_RevertSettleCancelledOrder() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        // Cancel seller order
        vm.prank(alice);
        router.cancel(SELLER_ORDER_ID);

        vm.prank(engine);
        vm.expectRevert("Seller not active");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_RevertDoubleSettle() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        // Try to settle again
        vm.prank(engine);
        vm.expectRevert("Seller not active");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_RevertMarkSettledWhenNotSettling() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        // Try to mark settled without first calling revealAndSettle
        vm.prank(engine);
        vm.expectRevert("Not settling");
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);
    }

    // ============ HASH MISMATCH ============

    function test_RevertHashMismatch() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Commit with wrong hash for seller
        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, keccak256("wrong-hash"));

        _commitBuyerOrder(buyer);

        vm.prank(engine);
        vm.expectRevert("Seller hash mismatch");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ FUZZ ============

    function testFuzz_DepositAmounts(uint256 amount) public {
        amount = bound(amount, 1, type(uint128).max);

        MockERC20 fuzzToken = new MockERC20("Fuzz", "FZZ");
        fuzzToken.mint(alice, amount);

        vm.prank(alice);
        fuzzToken.approve(address(router), amount);

        bytes32 orderId = keccak256(abi.encodePacked("fuzz-order-", amount));
        bytes32 orderHash = keccak256(abi.encodePacked("fuzz-hash-", amount));

        vm.prank(alice);
        router.depositAndCommit(address(fuzzToken), amount, orderId, orderHash);

        (address user,,, DarkPoolRouter.Status status) = router.commitments(orderId);
        assertEq(user, alice);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
        assertEq(custody.deposits(address(router), address(fuzzToken)), amount);
    }

    // ============ EVENTS ============

    function test_EventsSettling() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(engine);
        vm.expectEmit(true, true, false, false);
        emit DarkPoolRouter.OrdersSettling(SELLER_ORDER_ID, BUYER_ORDER_ID);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    function test_EventsSettled() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        _commitSellerOrder(seller);
        _commitBuyerOrder(buyer);

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);

        vm.prank(engine);
        vm.expectEmit(true, true, false, false);
        emit DarkPoolRouter.OrdersSettled(SELLER_ORDER_ID, BUYER_ORDER_ID);
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);
    }
}
