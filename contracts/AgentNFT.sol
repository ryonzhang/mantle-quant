// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentNFT
 * @author MantleQuant
 * @notice Soulbound identity NFT for AI trading agents.
 *
 *   Inspired by the ERC-8004 agent identity standard promoted by Mantle Network.
 *   Each agent mints exactly one NFT that cannot be transferred — reputation is
 *   tied to the agent's address, not a speculative token.
 *
 *   The token URI is fully on-chain (base64 JSON), requiring no external metadata
 *   server. Agent stats are queryable via the paired SignalRegistry contract.
 *
 *   Minimal ERC-721 implementation (no OpenZeppelin dependency) for lean bytecode.
 */
contract AgentNFT {

    // ─── ERC-721 State ────────────────────────────────────────────────────────

    string public constant name   = "Mantle Agent Identity";
    string public constant symbol = "AGNT";

    uint256 public totalSupply;

    mapping(uint256 => address)  public ownerOf;
    mapping(address => uint256)  public balanceOf;

    // ─── Custom State ─────────────────────────────────────────────────────────

    /// @notice Returns the token ID for an agent address (0 = not registered)
    mapping(address => uint256) public agentTokenId;

    struct AgentProfile {
        string  agentName;    // human-readable agent name
        string  agentType;    // "trading", "arbitrage", "market-making", etc.
        string  description;  // short description
        uint48  registeredAt; // block.timestamp at registration
    }
    mapping(uint256 => AgentProfile) public profiles;

    address public signalRegistry; // address of the paired SignalRegistry (set post-deploy)

    // ─── Events ───────────────────────────────────────────────────────────────

    /// @notice ERC-721 required
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    /// @notice Emitted when an agent registers
    event AgentRegistered(
        uint256 indexed tokenId,
        address indexed agent,
        string          agentName,
        string          agentType
    );

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _signalRegistry) {
        signalRegistry = _signalRegistry;
    }

    // ─── Registration ─────────────────────────────────────────────────────────

    /**
     * @notice Register as an AI agent and receive your soulbound identity NFT.
     * @param agentName   Display name for this agent
     * @param agentType   Category string (e.g. "trading", "arbitrage")
     * @param description Short description of the agent's strategy
     * @return tokenId    The minted NFT ID
     */
    function register(
        string calldata agentName,
        string calldata agentType,
        string calldata description
    ) external returns (uint256 tokenId) {
        require(agentTokenId[msg.sender] == 0, "AGNT: already registered");
        require(bytes(agentName).length > 0,   "AGNT: empty name");

        tokenId = ++totalSupply;
        ownerOf[tokenId]          = msg.sender;
        balanceOf[msg.sender]     = 1;
        agentTokenId[msg.sender]  = tokenId;
        profiles[tokenId]         = AgentProfile({
            agentName:    agentName,
            agentType:    agentType,
            description:  description,
            registeredAt: uint48(block.timestamp)
        });

        emit Transfer(address(0), msg.sender, tokenId);
        emit AgentRegistered(tokenId, msg.sender, agentName, agentType);
    }

    // ─── Soulbound ────────────────────────────────────────────────────────────

    /// @notice Soulbound — transfers revert
    function transferFrom(address, address, uint256) external pure {
        revert("AGNT: soulbound token");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("AGNT: soulbound token");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("AGNT: soulbound token");
    }

    function approve(address, uint256) external pure {
        revert("AGNT: soulbound token");
    }

    // ─── Metadata ─────────────────────────────────────────────────────────────

    /**
     * @notice Fully on-chain token metadata (no external server required).
     *         Returns a data URI with JSON attributes.
     */
    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "AGNT: nonexistent token");
        AgentProfile memory p = profiles[tokenId];

        return string(abi.encodePacked(
            'data:application/json;charset=utf-8,{',
            '"name":"', p.agentName, '",',
            '"description":"', p.description, '",',
            '"attributes":[',
                '{"trait_type":"Type","value":"', p.agentType, '"},',
                '{"trait_type":"Network","value":"Mantle"},',
                '{"trait_type":"Standard","value":"ERC-8004"},',
                '{"trait_type":"Soulbound","value":"true"},',
                '{"trait_type":"Registered","value":"', _toString(p.registeredAt), '"}',
            ']}'
        ));
    }

    // ─── ERC-165 ──────────────────────────────────────────────────────────────

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x80ac58cd  // ERC-721
            || interfaceId == 0x01ffc9a7; // ERC-165
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    function _toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits--;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}
