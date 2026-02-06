// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
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

        tokenA = new MockERC20("Token A", "TKA");
        tokenB = new MockERC20("Token B", "TKB");
        custody = new MockYellowCustody();
        router = new DarkPoolRouter(address(custody), engine);

        tokenA.mint(alice, 1000 ether);
        tokenB.mint(bob, 1000 ether);

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
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("DarkPool"),
                keccak256("1"),
                block.chainid,
                address(router)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
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

    function _commitBothOrders(DarkPoolRouter.OrderDetails memory seller, DarkPoolRouter.OrderDetails memory buyer)
        internal
    {
        vm.prank(alice);
        router.depositAndCommit(address(tokenA), 100 ether, SELLER_ORDER_ID, keccak256(abi.encode(seller)));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, keccak256(abi.encode(buyer)));
    }

    // ============ HAPPY PATH ============

    function test_FullLifecycle() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Commit
        _commitBothOrders(seller, buyer);

        (address user,,, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(user, alice);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Active));
        assertEq(custody.deposits(address(router), address(tokenA)), 100 ether);

        // Reveal + settle
        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
        (,,, status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settling));

        // Finalize
        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);
        (,,, status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settled));
    }

    function test_CommitOnlyFlow() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, keccak256(abi.encode(seller)));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, keccak256(abi.encode(buyer)));

        vm.prank(engine);
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
        vm.prank(engine);
        router.markFullySettled(SELLER_ORDER_ID, BUYER_ORDER_ID);

        (,,, DarkPoolRouter.Status status) = router.commitments(SELLER_ORDER_ID);
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Settled));
    }

    // ============ CANCEL ============

    function test_Cancel() public {
        vm.prank(alice);
        router.commitOnly(keccak256("order"), keccak256("hash"));

        vm.prank(alice);
        router.cancel(keccak256("order"));

        (,,, DarkPoolRouter.Status status) = router.commitments(keccak256("order"));
        assertEq(uint8(status), uint8(DarkPoolRouter.Status.Cancelled));
    }

    function test_RevertCancelNotOwner() public {
        vm.prank(alice);
        router.commitOnly(keccak256("order"), keccak256("hash"));

        vm.prank(bob);
        vm.expectRevert("Not your order");
        router.cancel(keccak256("order"));
    }

    // ============ ACCESS CONTROL ============

    function test_RevertOnlyEngine() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);
        _commitBothOrders(seller, buyer);

        vm.prank(alice);
        vm.expectRevert("Only engine");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ INVALID SIGNATURE ============

    function test_RevertBadSignature() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);

        // Sign seller order with bob's key
        seller.signature =
            _signOrder(bobKey, SELLER_ORDER_ID, address(tokenA), address(tokenB), 100 ether, 90 ether, expiresAt);

        vm.prank(alice);
        router.commitOnly(SELLER_ORDER_ID, keccak256(abi.encode(seller)));
        vm.prank(bob);
        router.depositAndCommit(address(tokenB), 95 ether, BUYER_ORDER_ID, keccak256(abi.encode(buyer)));

        vm.prank(engine);
        vm.expectRevert("Invalid seller signature");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ EXPIRY ============

    function test_RevertExpired() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);
        _commitBothOrders(seller, buyer);

        vm.warp(expiresAt + 1);

        vm.prank(engine);
        vm.expectRevert("Seller expired");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }

    // ============ REPLAY ============

    function test_RevertDoubleCommit() public {
        vm.prank(alice);
        router.commitOnly(keccak256("order"), keccak256("hash"));

        vm.prank(alice);
        vm.expectRevert("Order exists");
        router.commitOnly(keccak256("order"), keccak256("hash"));
    }

    function test_RevertSettleCancelled() public {
        uint256 expiresAt = block.timestamp + 1 hours;
        DarkPoolRouter.OrderDetails memory seller = _makeSellerOrder(expiresAt);
        DarkPoolRouter.OrderDetails memory buyer = _makeBuyerOrder(expiresAt);
        _commitBothOrders(seller, buyer);

        vm.prank(alice);
        router.cancel(SELLER_ORDER_ID);

        vm.prank(engine);
        vm.expectRevert("Seller not active");
        router.revealAndSettle(SELLER_ORDER_ID, BUYER_ORDER_ID, seller, buyer);
    }
}
