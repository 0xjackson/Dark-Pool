// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DarkPool
 * @dev Commit-reveal scheme for dark pool orders to prevent front-running
 * @notice This contract allows users to commit order hashes before revealing them
 */
contract DarkPool {
    // Events
    event OrderCommitted(
        address indexed user,
        bytes32 indexed commitmentHash,
        uint256 timestamp
    );

    event OrderRevealed(
        address indexed user,
        bytes32 indexed commitmentHash,
        address baseToken,
        address quoteToken,
        uint256 quantity,
        uint256 price,
        uint256 varianceBps,
        uint256 timestamp
    );

    event OrderCancelled(
        address indexed user,
        bytes32 indexed commitmentHash,
        uint256 timestamp
    );

    // Storage
    mapping(address => mapping(bytes32 => bool)) public commitments;
    mapping(address => mapping(bytes32 => uint256)) public commitmentTimestamps;

    // Minimum time between commit and reveal (to prevent same-block reveal)
    uint256 public constant MIN_REVEAL_DELAY = 1; // 1 block
    uint256 public constant MAX_COMMIT_AGE = 1 hours; // Commitments expire after 1 hour

    /**
     * @dev Commit an order hash
     * @param _commitmentHash keccak256 hash of the order details
     */
    function commitOrder(bytes32 _commitmentHash) external {
        require(_commitmentHash != bytes32(0), "Invalid commitment hash");
        require(!commitments[msg.sender][_commitmentHash], "Already committed");

        commitments[msg.sender][_commitmentHash] = true;
        commitmentTimestamps[msg.sender][_commitmentHash] = block.timestamp;

        emit OrderCommitted(msg.sender, _commitmentHash, block.timestamp);
    }

    /**
     * @dev Reveal a committed order
     * @param baseToken Token being bought/sold
     * @param quoteToken Token used for payment
     * @param quantity Amount of base token
     * @param price Price in quote token
     * @param varianceBps Slippage tolerance in basis points (100 = 1%)
     * @param nonce Random nonce to prevent hash collisions
     */
    function revealOrder(
        address baseToken,
        address quoteToken,
        uint256 quantity,
        uint256 price,
        uint256 varianceBps,
        uint256 nonce
    ) external {
        require(baseToken != address(0), "Invalid base token");
        require(quoteToken != address(0), "Invalid quote token");
        require(baseToken != quoteToken, "Tokens must be different");
        require(quantity > 0, "Quantity must be > 0");
        require(price > 0, "Price must be > 0");
        require(varianceBps <= 10000, "Variance must be <= 10000 (100%)");

        // Compute commitment hash
        bytes32 commitmentHash = keccak256(
            abi.encodePacked(
                msg.sender,
                baseToken,
                quoteToken,
                quantity,
                price,
                varianceBps,
                nonce
            )
        );

        // Verify commitment exists
        require(commitments[msg.sender][commitmentHash], "Not committed");

        // Verify reveal delay (prevents same-block reveal)
        uint256 commitTime = commitmentTimestamps[msg.sender][commitmentHash];
        require(
            block.timestamp >= commitTime + MIN_REVEAL_DELAY,
            "Reveal too soon"
        );

        // Verify commitment hasn't expired
        require(
            block.timestamp <= commitTime + MAX_COMMIT_AGE,
            "Commitment expired"
        );

        // Clear commitment
        delete commitments[msg.sender][commitmentHash];
        delete commitmentTimestamps[msg.sender][commitmentHash];

        emit OrderRevealed(
            msg.sender,
            commitmentHash,
            baseToken,
            quoteToken,
            quantity,
            price,
            varianceBps,
            block.timestamp
        );
    }

    /**
     * @dev Cancel a commitment
     * @param _commitmentHash Hash to cancel
     */
    function cancelCommitment(bytes32 _commitmentHash) external {
        require(commitments[msg.sender][_commitmentHash], "Not committed");

        delete commitments[msg.sender][_commitmentHash];
        delete commitmentTimestamps[msg.sender][_commitmentHash];

        emit OrderCancelled(msg.sender, _commitmentHash, block.timestamp);
    }

    /**
     * @dev Check if a commitment exists and is valid
     * @param user User address
     * @param _commitmentHash Commitment hash
     * @return exists Whether commitment exists
     * @return timestamp Commitment timestamp
     * @return expired Whether commitment has expired
     */
    function getCommitmentStatus(address user, bytes32 _commitmentHash)
        external
        view
        returns (
            bool exists,
            uint256 timestamp,
            bool expired
        )
    {
        exists = commitments[user][_commitmentHash];
        timestamp = commitmentTimestamps[user][_commitmentHash];
        expired = exists && (block.timestamp > timestamp + MAX_COMMIT_AGE);
    }

    /**
     * @dev Compute commitment hash (helper function for frontend)
     * @param user User address
     * @param baseToken Token being bought/sold
     * @param quoteToken Token used for payment
     * @param quantity Amount of base token
     * @param price Price in quote token
     * @param varianceBps Slippage tolerance in basis points
     * @param nonce Random nonce
     * @return Commitment hash
     */
    function computeCommitmentHash(
        address user,
        address baseToken,
        address quoteToken,
        uint256 quantity,
        uint256 price,
        uint256 varianceBps,
        uint256 nonce
    ) external pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    user,
                    baseToken,
                    quoteToken,
                    quantity,
                    price,
                    varianceBps,
                    nonce
                )
            );
    }
}
