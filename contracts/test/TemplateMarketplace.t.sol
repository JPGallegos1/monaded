// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TemplateMarketplace} from "../src/TemplateMarketplace.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

/// @dev Rejects every native transfer.
contract RejectingReceiver {
    receive() external payable {
        revert("no MON please");
    }
}

/// @dev Burns all forwarded gas when receiving MON.
contract GasBurner {
    receive() external payable {
        while (true) {}
    }
}

/// @dev Tries to re-enter `buy` when receiving its creator payment.
contract ReentrantCreator {
    TemplateMarketplace public market;
    uint256 public targetId;

    function setTarget(TemplateMarketplace m, uint256 id) external {
        market = m;
        targetId = id;
    }

    receive() external payable {
        market.buy{value: msg.value}(targetId);
    }
}

contract TemplateMarketplaceTest is Test {
    TemplateMarketplace internal market;
    MockUSDC internal usdc;

    address internal admin = makeAddr("admin");
    address internal relayer = makeAddr("relayer");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice"); // original creator
    address internal bob = makeAddr("bob"); // fork level 1
    address internal carol = makeAddr("carol"); // fork level 2
    address internal dave = makeAddr("dave"); // fork level 3
    address internal erin = makeAddr("erin"); // fork level 4
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant PRICE = 1 ether;
    uint256 internal constant ROYALTY_BPS = 1_000; // 10% per ancestor level

    event TemplatePublished(
        uint256 indexed templateId,
        address indexed creator,
        uint256 indexed parentId,
        uint256 price,
        address paymentToken,
        string metadataURI,
        address publisher
    );
    event Purchased(
        uint256 indexed templateId,
        address indexed buyer,
        address indexed creator,
        address paymentToken,
        uint256 price,
        uint256 creatorAmount,
        uint256 platformFee
    );
    event RoyaltyPaid(
        uint256 indexed templateId,
        uint256 indexed ancestorId,
        address indexed recipient,
        uint256 level,
        address paymentToken,
        uint256 amount
    );
    event PaymentDeferred(address indexed recipient, address indexed token, uint256 amount);

    function setUp() public {
        market = new TemplateMarketplace(admin, relayer, ROYALTY_BPS, 0, address(0));
        usdc = new MockUSDC();
        vm.deal(buyer, 100 ether);
    }

    // ------------------------------------------------------------------ helpers

    function _publish(address creator, uint256 price, uint256 parentId) internal returns (uint256) {
        vm.prank(creator);
        return market.publishTemplate(price, parentId, "ipfs://template");
    }

    /// alice(1) <- bob(2) <- carol(3) <- dave(4) <- erin(5)
    function _chain() internal returns (uint256 t1, uint256 t2, uint256 t3, uint256 t4, uint256 t5) {
        t1 = _publish(alice, PRICE, 0);
        t2 = _publish(bob, PRICE, t1);
        t3 = _publish(carol, PRICE, t2);
        t4 = _publish(dave, PRICE, t3);
        t5 = _publish(erin, PRICE, t4);
    }

    // ------------------------------------------------------------------ publish

    function test_Publish_RecordsTemplateAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit TemplatePublished(1, alice, 0, PRICE, address(0), "ipfs://a", alice);
        vm.prank(alice);
        uint256 id = market.publishTemplate(PRICE, 0, "ipfs://a");

        assertEq(id, 1);
        assertEq(market.nextTemplateId(), 2);
        TemplateMarketplace.Template memory t = market.getTemplate(id);
        assertEq(t.creator, alice);
        assertEq(t.price, PRICE);
        assertEq(t.parentId, 0);
        assertEq(t.paymentToken, address(0));
        assertEq(t.metadataURI, "ipfs://a");
        assertEq(market.uri(id), "ipfs://a");
        assertTrue(market.exists(id));
        assertFalse(market.exists(0));
        assertFalse(market.exists(2));
    }

    function test_Publish_RevertsOnUnknownParent() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TemplateMarketplace.ParentNotFound.selector, 42));
        market.publishTemplate(PRICE, 42, "ipfs://x");
    }

    function test_PublishFor_ByRelayerSetsCreator() public {
        vm.expectEmit(true, true, true, true);
        emit TemplatePublished(1, alice, 0, PRICE, address(0), "ipfs://r", relayer);
        vm.prank(relayer);
        uint256 id = market.publishFor(alice, PRICE, 0, "ipfs://r");
        assertEq(market.getTemplate(id).creator, alice);
    }

    function test_PublishFor_RevertsForNonRelayer() public {
        bytes32 role = market.RELAYER_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role)
        );
        market.publishFor(alice, PRICE, 0, "ipfs://r");
    }

    function test_PublishFor_RevertsOnZeroCreator() public {
        vm.prank(relayer);
        vm.expectRevert(TemplateMarketplace.ZeroAddress.selector);
        market.publishFor(address(0), PRICE, 0, "ipfs://r");
    }

    function test_AccessControl_AdminManagesRelayers() public {
        bytes32 role = market.RELAYER_ROLE();
        vm.prank(admin);
        market.grantRole(role, stranger);
        vm.prank(stranger);
        market.publishFor(alice, PRICE, 0, "ipfs://ok");

        vm.prank(admin);
        market.revokeRole(role, stranger);
        vm.prank(stranger);
        vm.expectRevert();
        market.publishFor(alice, PRICE, 0, "ipfs://nope");

        // Non-admins cannot grant roles or change fees.
        vm.prank(relayer);
        vm.expectRevert();
        market.grantRole(role, stranger);
        vm.prank(relayer);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, relayer, bytes32(0)
            )
        );
        market.setFeeConfig(0, 0, address(0));
    }

    function test_UpdateTemplate_CreatorOrRelayerOnly() public {
        uint256 id = _publish(alice, PRICE, 0);
        vm.prank(alice);
        market.updateTemplate(id, 2 ether, "ipfs://v2");
        assertEq(market.getTemplate(id).price, 2 ether);
        assertEq(market.uri(id), "ipfs://v2");

        vm.prank(relayer);
        market.updateTemplate(id, 3 ether, "ipfs://v3");
        assertEq(market.getTemplate(id).price, 3 ether);

        vm.prank(stranger);
        vm.expectRevert(TemplateMarketplace.NotCreatorOrRelayer.selector);
        market.updateTemplate(id, 0, "ipfs://hack");
    }

    // ------------------------------------------------------------------ buy

    function test_Buy_MintsLicenseAndPaysCreator() public {
        uint256 id = _publish(alice, PRICE, 0);

        vm.expectEmit(true, true, true, true);
        emit Purchased(id, buyer, alice, address(0), PRICE, PRICE, 0);
        vm.prank(buyer);
        market.buy{value: PRICE}(id);

        assertEq(market.balanceOf(buyer, id), 1);
        assertTrue(market.hasLicense(buyer, id));
        assertEq(alice.balance, PRICE);
        assertEq(address(market).balance, 0);
    }

    function test_Buy_RevertsOnUnderpayment() public {
        uint256 id = _publish(alice, PRICE, 0);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TemplateMarketplace.WrongPaymentAmount.selector, PRICE, PRICE - 1)
        );
        market.buy{value: PRICE - 1}(id);
    }

    function test_Buy_RevertsOnOverpayment() public {
        uint256 id = _publish(alice, PRICE, 0);
        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TemplateMarketplace.WrongPaymentAmount.selector, PRICE, PRICE + 1)
        );
        market.buy{value: PRICE + 1}(id);
    }

    function test_Buy_RevertsOnUnknownTemplate() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(TemplateMarketplace.TemplateNotFound.selector, 7));
        market.buy{value: PRICE}(7);
    }

    function test_Buy_FreeTemplate() public {
        uint256 id = _publish(alice, 0, 0);
        vm.prank(buyer);
        market.buy(id);
        assertEq(market.balanceOf(buyer, id), 1);
    }

    function test_Buy_TwiceMintsTwoLicenses() public {
        uint256 id = _publish(alice, PRICE, 0);
        vm.startPrank(buyer);
        market.buy{value: PRICE}(id);
        market.buy{value: PRICE}(id);
        vm.stopPrank();
        assertEq(market.balanceOf(buyer, id), 2);
    }

    // ------------------------------------------------------------------ royalties

    function test_Royalty_SingleLevelFork() public {
        uint256 parent = _publish(alice, PRICE, 0);
        uint256 fork = _publish(bob, PRICE, parent);

        vm.expectEmit(true, true, true, true);
        emit RoyaltyPaid(fork, parent, alice, 1, address(0), 0.1 ether);
        vm.expectEmit(true, true, true, true);
        emit Purchased(fork, buyer, bob, address(0), PRICE, 0.9 ether, 0);
        vm.prank(buyer);
        market.buy{value: PRICE}(fork);

        assertEq(alice.balance, 0.1 ether);
        assertEq(bob.balance, 0.9 ether);
        assertEq(alice.balance + bob.balance, PRICE);
        assertEq(address(market).balance, 0);
    }

    function test_Royalty_MultiLevelCascadeIsBoundedToThreeLevels() public {
        (,,,, uint256 t5) = _chain();

        vm.prank(buyer);
        market.buy{value: PRICE}(t5);

        // erin is the seller, dave/carol/bob are levels 1..3, alice (level 4) gets nothing.
        assertEq(erin.balance, 0.7 ether);
        assertEq(dave.balance, 0.1 ether);
        assertEq(carol.balance, 0.1 ether);
        assertEq(bob.balance, 0.1 ether);
        assertEq(alice.balance, 0);
        assertEq(erin.balance + dave.balance + carol.balance + bob.balance, PRICE);
        assertEq(address(market).balance, 0);
    }

    function test_Royalty_TwoLevels() public {
        (,, uint256 t3,,) = _chain();
        vm.prank(buyer);
        market.buy{value: PRICE}(t3);
        assertEq(carol.balance, 0.8 ether);
        assertEq(bob.balance, 0.1 ether);
        assertEq(alice.balance, 0.1 ether);
    }

    function test_Royalty_WithPlatformFee() public {
        vm.prank(admin);
        market.setFeeConfig(ROYALTY_BPS, 250, treasury); // 2.5% fee

        (,, uint256 t3,,) = _chain();
        vm.prank(buyer);
        market.buy{value: PRICE}(t3);

        uint256 fee = 0.025 ether;
        uint256 perLevel = (PRICE - fee) / 10; // 0.0975
        assertEq(treasury.balance, fee);
        assertEq(bob.balance, perLevel);
        assertEq(alice.balance, perLevel);
        assertEq(carol.balance, PRICE - fee - 2 * perLevel);
        assertEq(treasury.balance + alice.balance + bob.balance + carol.balance, PRICE);
    }

    function test_PreviewSplit_MatchesActualPayout() public {
        vm.prank(admin);
        market.setFeeConfig(ROYALTY_BPS, 300, treasury);
        (,,,, uint256 t5) = _chain();

        (address[] memory r, uint256[] memory a) = market.previewSplit(t5);
        assertEq(r.length, 5);
        assertEq(r[0], erin);
        assertEq(r[1], dave);
        assertEq(r[2], carol);
        assertEq(r[3], bob);
        assertEq(r[4], treasury);

        vm.prank(buyer);
        market.buy{value: PRICE}(t5);
        assertEq(erin.balance, a[0]);
        assertEq(dave.balance, a[1]);
        assertEq(carol.balance, a[2]);
        assertEq(bob.balance, a[3]);
        assertEq(treasury.balance, a[4]);
        assertEq(a[0] + a[1] + a[2] + a[3] + a[4], PRICE);
    }

    function testFuzz_SplitAlwaysSumsToPrice(uint96 price, uint16 royalty, uint16 fee) public {
        royalty = uint16(bound(royalty, 0, 1_000));
        fee = uint16(bound(fee, 0, 5_000 - 3 * uint256(royalty)));
        vm.prank(admin);
        market.setFeeConfig(royalty, fee, treasury);
        (,,,, uint256 t5) = _chain();
        vm.prank(erin);
        market.updateTemplate(t5, price, "ipfs://fuzz");

        vm.deal(buyer, price);
        vm.prank(buyer);
        market.buy{value: price}(t5);

        uint256 total =
            alice.balance + bob.balance + carol.balance + dave.balance + erin.balance + treasury.balance;
        assertEq(total, price);
        assertEq(alice.balance, 0);
        assertEq(address(market).balance, 0);
        assertGe(erin.balance * 2, uint256(price)); // creator always keeps >= 50%
    }

    function test_FeeConfig_RejectsExcessiveCut() public {
        vm.startPrank(admin);
        vm.expectRevert(TemplateMarketplace.InvalidFeeConfig.selector);
        market.setFeeConfig(1_500, 600, treasury); // 4500 + 600 > 5000
        vm.expectRevert(TemplateMarketplace.ZeroAddress.selector);
        market.setFeeConfig(1_000, 100, address(0)); // fee without recipient
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ pull fallback

    function test_PullFallback_RejectingCreator() public {
        RejectingReceiver rejecter = new RejectingReceiver();
        uint256 parent = _publish(address(rejecter), PRICE, 0);
        uint256 fork = _publish(bob, PRICE, parent);

        vm.expectEmit(true, true, false, true);
        emit PaymentDeferred(address(rejecter), address(0), 0.1 ether);
        vm.prank(buyer);
        market.buy{value: PRICE}(fork); // purchase still succeeds

        assertEq(bob.balance, 0.9 ether);
        assertEq(market.pendingWithdrawals(address(0), address(rejecter)), 0.1 ether);
        assertEq(address(market).balance, 0.1 ether);

        // Plain withdraw keeps failing for a contract that rejects MON...
        vm.prank(address(rejecter));
        vm.expectRevert(TemplateMarketplace.WithdrawFailed.selector);
        market.withdraw();

        // ...but it can redirect the funds.
        vm.prank(address(rejecter));
        market.withdrawTo(payable(stranger));
        assertEq(stranger.balance, 0.1 ether);
        assertEq(market.pendingWithdrawals(address(0), address(rejecter)), 0);
        assertEq(address(market).balance, 0);
    }

    function test_PullFallback_GasGriefingRecipientIsDeferred() public {
        GasBurner burner = new GasBurner();
        uint256 id = _publish(address(burner), PRICE, 0);
        vm.prank(buyer);
        market.buy{value: PRICE}(id);
        assertEq(market.balanceOf(buyer, id), 1);
        assertEq(market.pendingWithdrawals(address(0), address(burner)), PRICE);
    }

    function test_PullFallback_WithdrawByEOA() public {
        // A contract creator that later becomes able to receive: simulate by etching code away.
        RejectingReceiver rejecter = new RejectingReceiver();
        uint256 id = _publish(address(rejecter), PRICE, 0);
        vm.prank(buyer);
        market.buy{value: PRICE}(id);

        vm.etch(address(rejecter), ""); // now behaves like an EOA
        vm.prank(address(rejecter));
        market.withdraw();
        assertEq(address(rejecter).balance, PRICE);

        vm.prank(address(rejecter));
        vm.expectRevert(TemplateMarketplace.NothingToWithdraw.selector);
        market.withdraw();
    }

    function test_Reentrancy_CreatorCannotReenterBuy() public {
        ReentrantCreator attacker = new ReentrantCreator();
        uint256 id = _publish(address(attacker), PRICE, 0);
        attacker.setTarget(market, id);

        vm.prank(buyer);
        market.buy{value: PRICE}(id);

        // Re-entry reverted inside the push, so the payment was deferred and only 1 license minted.
        assertEq(market.balanceOf(buyer, id), 1);
        assertEq(market.balanceOf(address(attacker), id), 0);
        assertEq(market.pendingWithdrawals(address(0), address(attacker)), PRICE);
    }

    // ------------------------------------------------------------------ ERC-20 path

    function test_ERC20_PublishAndBuyWithRoyalty() public {
        vm.prank(admin);
        market.setAcceptedToken(address(usdc), true);

        vm.prank(relayer);
        uint256 parent = market.publishForERC20(alice, address(usdc), 10e6, 0, "ipfs://p");
        vm.prank(relayer);
        uint256 fork = market.publishForERC20(bob, address(usdc), 20e6, parent, "ipfs://f");

        usdc.mint(buyer, 20e6);
        vm.startPrank(buyer);
        usdc.approve(address(market), 20e6);
        market.buyWithToken(fork);
        vm.stopPrank();

        assertEq(market.balanceOf(buyer, fork), 1);
        assertEq(usdc.balanceOf(alice), 2e6);
        assertEq(usdc.balanceOf(bob), 18e6);
        assertEq(usdc.balanceOf(address(market)), 0);
    }

    function test_ERC20_Guards() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TemplateMarketplace.TokenNotAccepted.selector, address(usdc)));
        market.publishTemplateERC20(address(usdc), 1e6, 0, "ipfs://x");

        vm.prank(admin);
        market.setAcceptedToken(address(usdc), true);
        vm.prank(alice);
        uint256 tokenId = market.publishTemplateERC20(address(usdc), 1e6, 0, "ipfs://x");
        uint256 nativeId = _publish(alice, PRICE, 0);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TemplateMarketplace.WrongPaymentCurrency.selector, tokenId, address(usdc))
        );
        market.buy{value: 1e6}(tokenId);

        vm.prank(buyer);
        vm.expectRevert(
            abi.encodeWithSelector(TemplateMarketplace.WrongPaymentCurrency.selector, nativeId, address(0))
        );
        market.buyWithToken(nativeId);

        // No allowance -> revert, no license.
        usdc.mint(buyer, 1e6);
        vm.prank(buyer);
        vm.expectRevert();
        market.buyWithToken(tokenId);
        assertEq(market.balanceOf(buyer, tokenId), 0);
    }
}
