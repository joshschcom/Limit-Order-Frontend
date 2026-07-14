export const seltraSettlementAbi = [
  {
    type: "function",
    name: "fillsPaused",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "currentEpoch",
    stateMutability: "view",
    inputs: [{ name: "maker", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "incrementEpoch",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  {
    type: "event",
    name: "OrderFilledDEX",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: true },
      { name: "maker", type: "address", indexed: true },
      { name: "keeper", type: "address", indexed: true },
      { name: "makingAmount", type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
      { name: "makerImprovement", type: "uint256", indexed: false },
      { name: "keeperReward", type: "uint256", indexed: false },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const permit2Abi = [
  {
    type: "function",
    name: "invalidateUnorderedNonces",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wordPos", type: "uint256" },
      { name: "mask", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

