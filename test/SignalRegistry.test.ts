import { expect } from "chai";
import { ethers } from "hardhat";
import { SignalRegistry, AgentNFT } from "../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

enum Direction { NEUTRAL, LONG, SHORT }

describe("SignalRegistry", () => {
  let registry: SignalRegistry;
  let agentNFT:  AgentNFT;
  let owner:     Awaited<ReturnType<typeof ethers.getSigner>>;
  let agent:     Awaited<ReturnType<typeof ethers.getSigner>>;

  beforeEach(async () => {
    [owner, agent] = await ethers.getSigners();

    const SR = await ethers.getContractFactory("SignalRegistry");
    registry = await SR.deploy() as SignalRegistry;

    const AN = await ethers.getContractFactory("AgentNFT");
    agentNFT = await AN.deploy(await registry.getAddress()) as AgentNFT;
  });

  // ── Recording ────────────────────────────────────────────────────────────

  it("records a signal and increments signalCount", async () => {
    await registry.connect(agent).recordSignal(
      "BTC", Direction.LONG, 750,
      BigInt(6_500_000_000_000), // $65 000.00000000
      60,
      ethers.keccak256(ethers.toUtf8Bytes("analysis-1"))
    );

    expect(await registry.signalCount()).to.equal(1n);

    const sig = await registry.signals(0);
    expect(sig.agent).to.equal(agent.address);
    expect(sig.asset).to.equal("BTC");
    expect(sig.direction).to.equal(Direction.LONG);
    expect(sig.confidence).to.equal(750);
    expect(sig.resolved).to.be.false;
  });

  it("emits SignalRecorded event", async () => {
    const hash = ethers.keccak256(ethers.toUtf8Bytes("test"));
    await expect(
      registry.connect(agent).recordSignal(
        "ETH", Direction.SHORT, 600,
        BigInt(3_00000000), // $3.00
        30,
        hash
      )
    )
      .to.emit(registry, "SignalRecorded")
      .withArgs(0, agent.address, "ETH", Direction.SHORT, 600, BigInt(3_00000000), hash);
  });

  it("rejects confidence > 1000", async () => {
    await expect(
      registry.connect(agent).recordSignal(
        "BTC", Direction.LONG, 1001,
        BigInt(6_500000000), 60,
        ethers.ZeroHash
      )
    ).to.be.revertedWith("MQ: confidence > 1000");
  });

  it("rejects zero entry price", async () => {
    await expect(
      registry.connect(agent).recordSignal(
        "BTC", Direction.LONG, 500, 0n, 60, ethers.ZeroHash
      )
    ).to.be.revertedWith("MQ: zero entry price");
  });

  // ── Resolution ───────────────────────────────────────────────────────────

  it("resolves a signal after horizon and records correct LONG", async () => {
    await registry.connect(agent).recordSignal(
      "BTC", Direction.LONG, 800,
      BigInt(6_500_000_000_000), // $65 000 * 1e8
      60, // 60 min
      ethers.ZeroHash
    );

    await time.increase(61 * 60); // advance 61 minutes

    // Exit price $70 000 → return +7.69%
    await registry.connect(agent).resolveSignal(0, BigInt(7_000_000_000_000));

    const sig = await registry.signals(0);
    expect(sig.resolved).to.be.true;
    expect(sig.returnBps).to.be.gt(0);

    expect(await registry.agentCorrect(agent.address)).to.equal(1n);
  });

  it("resolves a SHORT signal that gains when price drops", async () => {
    await registry.connect(agent).recordSignal(
      "ETH", Direction.SHORT, 700,
      BigInt(3_00000000), // $3 * 1e8
      30,
      ethers.ZeroHash
    );

    await time.increase(31 * 60);

    // Exit price $2.50 → SHORT returns +16.67%
    await registry.connect(agent).resolveSignal(0, BigInt(2_50000000));

    const sig = await registry.signals(0);
    expect(sig.returnBps).to.be.gt(0);
    expect(await registry.agentCorrect(agent.address)).to.equal(1n);
  });

  it("reverts resolution before horizon elapses", async () => {
    await registry.connect(agent).recordSignal(
      "BTC", Direction.LONG, 800,
      BigInt(6_500_000_000_000), 60, ethers.ZeroHash
    );

    await expect(
      registry.connect(agent).resolveSignal(0, BigInt(7_000_000_000_000))
    ).to.be.revertedWith("MQ: horizon not elapsed");
  });

  it("reverts double resolution", async () => {
    await registry.connect(agent).recordSignal(
      "BTC", Direction.LONG, 800,
      BigInt(6_500_000_000_000), 60, ethers.ZeroHash
    );

    await time.increase(61 * 60);
    await registry.connect(agent).resolveSignal(0, BigInt(7_000_000_000_000));

    await expect(
      registry.connect(agent).resolveSignal(0, BigInt(7_000_000_000_000))
    ).to.be.revertedWith("MQ: already resolved");
  });

  // ── Stats ────────────────────────────────────────────────────────────────

  it("getAgentSignals returns correct IDs", async () => {
    for (let i = 0; i < 3; i++) {
      await registry.connect(agent).recordSignal(
        "MNT", Direction.LONG, 500,
        BigInt(1_00000000), 60, ethers.ZeroHash
      );
    }
    const ids = await registry.getAgentSignals(agent.address);
    expect(ids.length).to.equal(3);
    expect(ids.map(Number)).to.deep.equal([0, 1, 2]);
  });

  it("getAgentAccuracy returns 0 when nothing resolved", async () => {
    await registry.connect(agent).recordSignal(
      "BTC", Direction.LONG, 800, BigInt(6_500_000_000_000), 60, ethers.ZeroHash
    );
    expect(await registry.getAgentAccuracy(agent.address)).to.equal(0n);
  });

  it("getSignals paginates correctly", async () => {
    for (let i = 0; i < 5; i++) {
      await registry.connect(agent).recordSignal(
        "BTC", Direction.NEUTRAL, 0,
        BigInt(6_500_000_000_000), 60, ethers.ZeroHash
      );
    }
    const page = await registry.getSignals(2, 3);
    expect(page.length).to.equal(3);
    expect(page[0].id).to.equal(2n);
    expect(page[2].id).to.equal(4n);
  });
});

// ── AgentNFT ──────────────────────────────────────────────────────────────────

describe("AgentNFT", () => {
  let agentNFT: AgentNFT;
  let alice:    Awaited<ReturnType<typeof ethers.getSigner>>;
  let bob:      Awaited<ReturnType<typeof ethers.getSigner>>;

  beforeEach(async () => {
    [, alice, bob] = await ethers.getSigners();
    const SR = await ethers.getContractFactory("SignalRegistry");
    const registry = await SR.deploy();

    const AN = await ethers.getContractFactory("AgentNFT");
    agentNFT = await AN.deploy(await registry.getAddress()) as AgentNFT;
  });

  it("mints soulbound NFT on register", async () => {
    await agentNFT.connect(alice).register("AlphaBot", "trading", "Trend-following quant");
    expect(await agentNFT.balanceOf(alice.address)).to.equal(1n);
    expect(await agentNFT.ownerOf(1)).to.equal(alice.address);
    expect(await agentNFT.agentTokenId(alice.address)).to.equal(1n);
  });

  it("reverts double registration", async () => {
    await agentNFT.connect(alice).register("Bot1", "trading", "desc");
    await expect(
      agentNFT.connect(alice).register("Bot2", "arb", "desc2")
    ).to.be.revertedWith("AGNT: already registered");
  });

  it("reverts transfer (soulbound)", async () => {
    await agentNFT.connect(alice).register("AlphaBot", "trading", "desc");
    await expect(
      agentNFT.connect(alice).transferFrom(alice.address, bob.address, 1)
    ).to.be.revertedWith("AGNT: soulbound token");
  });

  it("tokenURI is valid on-chain JSON", async () => {
    await agentNFT.connect(alice).register("QuantBot", "trading", "A quant bot");
    const uri = await agentNFT.tokenURI(1);
    expect(uri).to.include("data:application/json");
    expect(uri).to.include("QuantBot");
    expect(uri).to.include("Mantle");
  });

  it("multiple agents get sequential token IDs", async () => {
    await agentNFT.connect(alice).register("Bot-A", "trading", "desc");
    await agentNFT.connect(bob).register("Bot-B",  "arb",     "desc");
    expect(await agentNFT.totalSupply()).to.equal(2n);
    expect(await agentNFT.agentTokenId(alice.address)).to.equal(1n);
    expect(await agentNFT.agentTokenId(bob.address)).to.equal(2n);
  });
});
