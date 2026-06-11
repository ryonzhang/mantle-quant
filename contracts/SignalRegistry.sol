// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SignalRegistry
 * @author MantleQuant
 * @notice On-chain registry for AI-generated trading signals.
 *
 *   Every signal is immutable once written — no cherry-picking, no retroactive edits.
 *   This enables verifiable AI performance benchmarking at scale on Mantle Network,
 *   directly embodying the hackathon's core thesis: "the first on-chain environment
 *   to benchmark AI agent performance."
 *
 *   Signals are resolved after their horizon period; accuracy and return metrics
 *   accumulate on-chain, forming an auditable reputation for each agent.
 */
contract SignalRegistry {

    // ─── Enums ───────────────────────────────────────────────────────────────

    /// @notice Trade direction encoded as uint8 for gas efficiency
    enum Direction { NEUTRAL, LONG, SHORT }

    // ─── Structs ─────────────────────────────────────────────────────────────

    struct Signal {
        uint256  id;
        address  agent;          // agent wallet address
        string   asset;          // e.g. "BTC", "ETH", "MNT"
        Direction direction;     // LONG / SHORT / NEUTRAL
        uint16   confidence;     // 0–1000  (0.0 %–100.0 %, 1 dp precision)
        uint128  entryPrice;     // price * 1e8 at creation time
        uint32   horizon;        // signal horizon in minutes
        uint48   timestamp;      // block.timestamp at creation
        bytes32  analysisHash;   // keccak256 of off-chain JSON analysis
        uint128  exitPrice;      // price * 1e8 at resolution (0 until resolved)
        bool     resolved;       // true once outcome is known
        int64    returnBps;      // actual return in basis points (filled on resolve)
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    uint256 public signalCount;
    address public owner;

    mapping(uint256 => Signal)          public signals;
    mapping(address => uint256[])       private _agentSignalIds;
    mapping(address => uint256)         public agentCorrect;
    mapping(address => int256)          public agentTotalReturnBps;

    // ─── Events ──────────────────────────────────────────────────────────────

    event SignalRecorded(
        uint256 indexed id,
        address indexed agent,
        string          asset,
        Direction       direction,
        uint16          confidence,
        uint128         entryPrice,
        bytes32         analysisHash
    );

    event SignalResolved(
        uint256 indexed id,
        uint128         exitPrice,
        int64           returnBps,
        bool            correct
    );

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "MQ: not owner");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor() {
        owner = msg.sender;
    }

    // ─── Core Functions ──────────────────────────────────────────────────────

    /**
     * @notice Record a new AI trading signal on-chain.
     * @param asset         Ticker string, e.g. "BTC"
     * @param direction     LONG (1), SHORT (2), or NEUTRAL (0)
     * @param confidence    Signal confidence 0–1000 (= 0.0 %–100.0 %)
     * @param entryPrice    Current price scaled by 1e8
     * @param horizon       Signal horizon in minutes
     * @param analysisHash  keccak256 of off-chain analysis JSON (verifiable off-chain)
     * @return id           Monotonically increasing signal ID
     */
    function recordSignal(
        string   calldata asset,
        Direction         direction,
        uint16            confidence,
        uint128           entryPrice,
        uint32            horizon,
        bytes32           analysisHash
    ) external returns (uint256 id) {
        require(confidence <= 1000, "MQ: confidence > 1000");
        require(entryPrice > 0,     "MQ: zero entry price");
        require(horizon   > 0,      "MQ: zero horizon");

        id = signalCount++;
        signals[id] = Signal({
            id:           id,
            agent:        msg.sender,
            asset:        asset,
            direction:    direction,
            confidence:   confidence,
            entryPrice:   entryPrice,
            horizon:      horizon,
            timestamp:    uint48(block.timestamp),
            analysisHash: analysisHash,
            exitPrice:    0,
            resolved:     false,
            returnBps:    0
        });
        _agentSignalIds[msg.sender].push(id);

        emit SignalRecorded(id, msg.sender, asset, direction, confidence, entryPrice, analysisHash);
    }

    /**
     * @notice Resolve a signal with the actual exit price after the horizon expires.
     *         Only callable by the original agent or the contract owner.
     *         Updates the agent's on-chain accuracy and cumulative return stats.
     * @param id        Signal ID to resolve
     * @param exitPrice Exit price scaled by 1e8
     */
    function resolveSignal(uint256 id, uint128 exitPrice) external {
        Signal storage s = signals[id];
        require(!s.resolved,                                    "MQ: already resolved");
        require(s.agent == msg.sender || msg.sender == owner,  "MQ: not authorized");
        require(exitPrice > 0,                                  "MQ: zero exit price");
        require(
            block.timestamp >= uint256(s.timestamp) + uint256(s.horizon) * 60,
            "MQ: horizon not elapsed"
        );

        s.exitPrice  = exitPrice;
        s.resolved   = true;

        // Compute return in basis points (negative = loss)
        int256 diff  = int256(uint256(exitPrice)) - int256(uint256(s.entryPrice));
        int64  ret   = int64(diff * 10_000 / int256(uint256(s.entryPrice)));
        if (s.direction == Direction.SHORT) ret = -ret;
        s.returnBps  = ret;

        // ret is already negated for SHORT above, so a profitable trade always has ret > 0
        bool correct = ret > 0 && s.direction != Direction.NEUTRAL;
        if (correct) agentCorrect[s.agent]++;
        agentTotalReturnBps[s.agent] += ret;

        emit SignalResolved(id, exitPrice, ret, correct);
    }

    // ─── View Functions ──────────────────────────────────────────────────────

    /// @notice All signal IDs emitted by a specific agent
    function getAgentSignals(address agent) external view returns (uint256[] memory) {
        return _agentSignalIds[agent];
    }

    /// @notice Agent win-rate in basis points (0–10 000)
    function getAgentAccuracy(address agent) external view returns (uint256 accuracyBps) {
        uint256[] memory ids     = _agentSignalIds[agent];
        uint256            total = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (signals[ids[i]].resolved) total++;
        }
        if (total == 0) return 0;
        return (agentCorrect[agent] * 10_000) / total;
    }

    /**
     * @notice Paginated batch read — useful for frontends and indexers.
     * @param from   First signal ID (inclusive)
     * @param count  Max number of signals to return
     */
    function getSignals(
        uint256 from,
        uint256 count
    ) external view returns (Signal[] memory result) {
        uint256 total = signalCount;
        if (from >= total) return new Signal[](0);
        uint256 end = from + count > total ? total : from + count;
        result = new Signal[](end - from);
        for (uint256 i = from; i < end; i++) {
            result[i - from] = signals[i];
        }
    }

    /// @notice Summary stats for an agent
    function getAgentStats(address agent) external view returns (
        uint256 total,
        uint256 resolved,
        uint256 correct,
        int256  totalReturnBps,
        uint256 accuracyBps
    ) {
        uint256[] memory ids = _agentSignalIds[agent];
        total    = ids.length;
        resolved = 0;
        for (uint256 i = 0; i < ids.length; i++) {
            if (signals[ids[i]].resolved) resolved++;
        }
        correct        = agentCorrect[agent];
        totalReturnBps = agentTotalReturnBps[agent];
        accuracyBps    = resolved > 0 ? (correct * 10_000) / resolved : 0;
    }
}
