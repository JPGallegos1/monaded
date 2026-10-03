// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title TemplateMarketplace
/// @notice Onchain marketplace for AI-generated study templates on Monad.
///         Every template is an ERC-1155 token id; buying a template mints one
///         license (amount = 1) of that id to the buyer. Payments are split in the
///         same transaction between the creator, the creators of up to
///         `MAX_ROYALTY_DEPTH` ancestor templates (forks) and an optional platform fee.
/// @dev Payment model: push payments with a pull fallback. Each recipient is paid
///      directly with a gas-capped call (native MON) or a non-reverting token
///      transfer (ERC-20). If a push fails, the amount is credited to
///      `pendingWithdrawals` and can be claimed later with `withdraw` / `withdrawToken`.
contract TemplateMarketplace is ERC1155, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Constants & roles
    // ---------------------------------------------------------------------

    /// @notice Role allowed to publish templates on behalf of creators (backend relayer).
    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @notice Maximum number of ancestor levels that receive royalties on a fork sale.
    uint256 public constant MAX_ROYALTY_DEPTH = 3;

    /// @notice Basis points denominator (100% = 10_000).
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Upper bound for `platformFeeBps + MAX_ROYALTY_DEPTH * royaltyBps`, so the
    ///         creator of the purchased template always keeps at least 50% of the price.
    uint256 public constant MAX_TOTAL_CUT_BPS = 5_000;

    /// @notice Gas forwarded on native push payments. Enough for EOAs and simple smart
    ///         wallets, small enough that a malicious recipient cannot grief a purchase.
    uint256 public constant PUSH_GAS_LIMIT = 50_000;

    /// @notice Sentinel used as "token" for native MON in pending balances and events.
    address public constant NATIVE = address(0);

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    struct Template {
        address creator; // onchain owner, receives sale proceeds
        address paymentToken; // address(0) = native MON, otherwise an allowlisted ERC-20
        uint256 price; // in wei (native) or token base units
        uint256 parentId; // 0 = original template, otherwise the forked template id
        string metadataURI; // e.g. ipfs://... or https://api.../templates/<id>.json
    }

    /// @notice Next template id to be assigned (ids start at 1; 0 means "no parent").
    uint256 public nextTemplateId = 1;

    /// @notice Royalty (bps of the net amount) paid to EACH ancestor level of a fork.
    uint256 public royaltyBps;

    /// @notice Platform fee (bps of the price). Can be 0.
    uint256 public platformFeeBps;

    /// @notice Receiver of the platform fee.
    address public feeRecipient;

    mapping(uint256 templateId => Template) private _templates;

    /// @notice ERC-20 tokens accepted as payment currency.
    mapping(address token => bool) public acceptedTokens;

    /// @notice Failed push payments, claimable by the recipient. token = address(0) for MON.
    mapping(address token => mapping(address account => uint256)) public pendingWithdrawals;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event TemplatePublished(
        uint256 indexed templateId,
        address indexed creator,
        uint256 indexed parentId,
        uint256 price,
        address paymentToken,
        string metadataURI,
        address publisher
    );
    event TemplateUpdated(uint256 indexed templateId, uint256 price, string metadataURI);
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
    event Withdrawn(address indexed account, address indexed token, uint256 amount);
    event FeeConfigUpdated(uint256 royaltyBps, uint256 platformFeeBps, address feeRecipient);
    event AcceptedTokenUpdated(address indexed token, bool accepted);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error TemplateNotFound(uint256 templateId);
    error ParentNotFound(uint256 parentId);
    error ZeroAddress();
    error WrongPaymentAmount(uint256 expected, uint256 received);
    error WrongPaymentCurrency(uint256 templateId, address expectedToken);
    error TokenNotAccepted(address token);
    error InvalidFeeConfig();
    error NotCreatorOrRelayer();
    error NothingToWithdraw();
    error WithdrawFailed();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param admin Account receiving DEFAULT_ADMIN_ROLE.
    /// @param relayer Initial relayer (can be address(0) to skip).
    /// @param royaltyBps_ Royalty per ancestor level, e.g. 1000 = 10%.
    /// @param platformFeeBps_ Platform fee, e.g. 0 or 250 = 2.5%.
    /// @param feeRecipient_ Receiver of platform fees (required if fee > 0).
    constructor(
        address admin,
        address relayer,
        uint256 royaltyBps_,
        uint256 platformFeeBps_,
        address feeRecipient_
    ) ERC1155("") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        if (relayer != address(0)) _grantRole(RELAYER_ROLE, relayer);
        _setFeeConfig(royaltyBps_, platformFeeBps_, feeRecipient_);
    }

    // ---------------------------------------------------------------------
    // Publishing
    // ---------------------------------------------------------------------

    /// @notice Publish a template priced in native MON; the caller becomes the creator.
    function publishTemplate(uint256 price, uint256 parentId, string calldata uri_)
        external
        returns (uint256 templateId)
    {
        return _publish(msg.sender, NATIVE, price, parentId, uri_);
    }

    /// @notice Relayer publishes a native-MON template on behalf of `creator`.
    function publishFor(address creator, uint256 price, uint256 parentId, string calldata uri_)
        external
        onlyRole(RELAYER_ROLE)
        returns (uint256 templateId)
    {
        return _publish(creator, NATIVE, price, parentId, uri_);
    }

    /// @notice Publish a template priced in an allowlisted ERC-20 (e.g. USDC).
    function publishTemplateERC20(address token, uint256 price, uint256 parentId, string calldata uri_)
        external
        returns (uint256 templateId)
    {
        if (!acceptedTokens[token]) revert TokenNotAccepted(token);
        return _publish(msg.sender, token, price, parentId, uri_);
    }

    /// @notice Relayer publishes an ERC-20-priced template on behalf of `creator`.
    function publishForERC20(
        address creator,
        address token,
        uint256 price,
        uint256 parentId,
        string calldata uri_
    ) external onlyRole(RELAYER_ROLE) returns (uint256 templateId) {
        if (!acceptedTokens[token]) revert TokenNotAccepted(token);
        return _publish(creator, token, price, parentId, uri_);
    }

    /// @notice Update price and metadata. Callable by the creator or a relayer.
    ///         The payment currency and the parent link are immutable.
    function updateTemplate(uint256 templateId, uint256 price, string calldata uri_) external {
        Template storage t = _getTemplate(templateId);
        if (msg.sender != t.creator && !hasRole(RELAYER_ROLE, msg.sender)) revert NotCreatorOrRelayer();
        t.price = price;
        t.metadataURI = uri_;
        emit TemplateUpdated(templateId, price, uri_);
        emit URI(uri_, templateId);
    }

    function _publish(address creator, address token, uint256 price, uint256 parentId, string calldata uri_)
        internal
        returns (uint256 templateId)
    {
        if (creator == address(0)) revert ZeroAddress();
        if (parentId != 0 && !exists(parentId)) revert ParentNotFound(parentId);

        templateId = nextTemplateId++;
        _templates[templateId] = Template({
            creator: creator, paymentToken: token, price: price, parentId: parentId, metadataURI: uri_
        });

        emit TemplatePublished(templateId, creator, parentId, price, token, uri_, msg.sender);
        emit URI(uri_, templateId);
    }

    // ---------------------------------------------------------------------
    // Buying
    // ---------------------------------------------------------------------

    /// @notice Buy one license of a native-MON template. `msg.value` must equal the price exactly.
    function buy(uint256 templateId) external payable nonReentrant {
        Template storage t = _getTemplate(templateId);
        if (t.paymentToken != NATIVE) revert WrongPaymentCurrency(templateId, t.paymentToken);
        if (msg.value != t.price) revert WrongPaymentAmount(t.price, msg.value);

        _mint(msg.sender, templateId, 1, "");
        _distribute(templateId, t, NATIVE, msg.value);
    }

    /// @notice Buy one license of an ERC-20 template. The buyer must have approved `price`.
    function buyWithToken(uint256 templateId) external nonReentrant {
        Template storage t = _getTemplate(templateId);
        address token = t.paymentToken;
        if (token == NATIVE) revert WrongPaymentCurrency(templateId, NATIVE);

        uint256 price = t.price;
        if (price > 0) {
            uint256 balanceBefore = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), price);
            uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
            if (received != price) revert WrongPaymentAmount(price, received); // fee-on-transfer tokens
        }

        _mint(msg.sender, templateId, 1, "");
        _distribute(templateId, t, token, price);
    }

    /// @notice Preview how a sale of `templateId` would be split.
    /// @return recipients [creator, ancestor creators..., feeRecipient (if fee > 0)]
    /// @return amounts Matching amounts; they always sum to the template price.
    function previewSplit(uint256 templateId)
        external
        view
        returns (address[] memory recipients, uint256[] memory amounts)
    {
        Template storage t = _getTemplate(templateId);
        uint256 price = t.price;
        uint256 fee = (price * platformFeeBps) / BPS_DENOMINATOR;
        uint256 net = price - fee;
        uint256 perLevel = (net * royaltyBps) / BPS_DENOMINATOR;

        uint256 depth = _ancestorDepth(t.parentId);
        uint256 n = 1 + depth + (fee > 0 ? 1 : 0);
        recipients = new address[](n);
        amounts = new uint256[](n);

        uint256 creatorAmount = net - perLevel * depth;
        recipients[0] = t.creator;
        amounts[0] = creatorAmount;

        uint256 ancestorId = t.parentId;
        for (uint256 i = 0; i < depth; ++i) {
            Template storage a = _templates[ancestorId];
            recipients[1 + i] = a.creator;
            amounts[1 + i] = perLevel;
            ancestorId = a.parentId;
        }
        if (fee > 0) {
            recipients[n - 1] = feeRecipient;
            amounts[n - 1] = fee;
        }
    }

    function _distribute(uint256 templateId, Template storage t, address token, uint256 price) internal {
        uint256 fee = (price * platformFeeBps) / BPS_DENOMINATOR;
        uint256 net = price - fee;
        uint256 perLevel = (net * royaltyBps) / BPS_DENOMINATOR;
        uint256 royaltiesTotal;

        if (perLevel > 0) {
            uint256 ancestorId = t.parentId;
            for (uint256 level = 1; level <= MAX_ROYALTY_DEPTH && ancestorId != 0; ++level) {
                Template storage a = _templates[ancestorId];
                _pay(token, a.creator, perLevel);
                royaltiesTotal += perLevel;
                emit RoyaltyPaid(templateId, ancestorId, a.creator, level, token, perLevel);
                ancestorId = a.parentId;
            }
        }

        // Rounding dust stays with the creator, so all amounts always sum to `price`.
        uint256 creatorAmount = net - royaltiesTotal;
        if (fee > 0) _pay(token, feeRecipient, fee);
        if (creatorAmount > 0) _pay(token, t.creator, creatorAmount);

        emit Purchased(templateId, msg.sender, t.creator, token, price, creatorAmount, fee);
    }

    /// @dev Push payment with pull fallback. Never reverts on recipient failure.
    function _pay(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        bool ok;
        if (token == NATIVE) {
            (ok,) = payable(to).call{value: amount, gas: PUSH_GAS_LIMIT}("");
        } else {
            ok = _tryTransferToken(token, to, amount);
        }
        if (!ok) {
            pendingWithdrawals[token][to] += amount;
            emit PaymentDeferred(to, token, amount);
        }
    }

    function _tryTransferToken(address token, address to, uint256 amount) internal returns (bool) {
        (bool success, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        return success && (data.length == 0 ? token.code.length > 0 : abi.decode(data, (bool)));
    }

    // ---------------------------------------------------------------------
    // Pull payments
    // ---------------------------------------------------------------------

    /// @notice Claim deferred native MON payments.
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[NATIVE][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[NATIVE][msg.sender] = 0;
        emit Withdrawn(msg.sender, NATIVE, amount);
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice Claim deferred native MON payments to a different address
    ///         (useful when the original recipient is a contract that rejects MON).
    function withdrawTo(address payable to) external nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = pendingWithdrawals[NATIVE][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[NATIVE][msg.sender] = 0;
        emit Withdrawn(msg.sender, NATIVE, amount);
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert WithdrawFailed();
    }

    /// @notice Claim deferred ERC-20 payments.
    function withdrawToken(address token) external nonReentrant {
        uint256 amount = pendingWithdrawals[token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        pendingWithdrawals[token][msg.sender] = 0;
        emit Withdrawn(msg.sender, token, amount);
        IERC20(token).safeTransfer(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFeeConfig(uint256 royaltyBps_, uint256 platformFeeBps_, address feeRecipient_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setFeeConfig(royaltyBps_, platformFeeBps_, feeRecipient_);
    }

    function setAcceptedToken(address token, bool accepted) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress();
        acceptedTokens[token] = accepted;
        emit AcceptedTokenUpdated(token, accepted);
    }

    function _setFeeConfig(uint256 royaltyBps_, uint256 platformFeeBps_, address feeRecipient_) internal {
        if (platformFeeBps_ + MAX_ROYALTY_DEPTH * royaltyBps_ > MAX_TOTAL_CUT_BPS) revert InvalidFeeConfig();
        if (platformFeeBps_ > 0 && feeRecipient_ == address(0)) revert ZeroAddress();
        royaltyBps = royaltyBps_;
        platformFeeBps = platformFeeBps_;
        feeRecipient = feeRecipient_;
        emit FeeConfigUpdated(royaltyBps_, platformFeeBps_, feeRecipient_);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function exists(uint256 templateId) public view returns (bool) {
        return templateId != 0 && templateId < nextTemplateId;
    }

    function getTemplate(uint256 templateId) external view returns (Template memory) {
        return _getTemplate(templateId);
    }

    /// @notice True if `account` holds at least one license for `templateId`.
    function hasLicense(address account, uint256 templateId) external view returns (bool) {
        return balanceOf(account, templateId) > 0;
    }

    /// @notice ERC-1155 metadata URI for a template id.
    function uri(uint256 templateId) public view override returns (string memory) {
        return _getTemplate(templateId).metadataURI;
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    function _getTemplate(uint256 templateId) internal view returns (Template storage t) {
        if (!exists(templateId)) revert TemplateNotFound(templateId);
        t = _templates[templateId];
    }

    function _ancestorDepth(uint256 parentId) internal view returns (uint256 depth) {
        while (parentId != 0 && depth < MAX_ROYALTY_DEPTH) {
            ++depth;
            parentId = _templates[parentId].parentId;
        }
    }
}
