// Integer math mirroring the contract: maker share floors, protocol fee floors
// off the keeper side, keeper receives the remainder including dust (SDK spec §8).
export function splitSurplus(surplus: bigint, makerBps = 7000n, protocolFeeBps = 0n) {
  const makerImprovement = (surplus * makerBps) / 10000n;
  const keeperSide = surplus - makerImprovement;
  const protocolFee = (keeperSide * protocolFeeBps) / 10000n;
  return { makerImprovement, protocolFee, keeperReward: keeperSide - protocolFee };
}
