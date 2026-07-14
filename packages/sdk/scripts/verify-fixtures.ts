/**
 * Cross-checks this SDK against the contracts repo's pinned fixtures
 * (contracts/test/OrderHash.t.sol). The witness hash and full
 * PermitWitnessTransferFrom digest must match byte-for-byte, or orders signed
 * by this SDK are unfillable on-chain. Run: npx tsx packages/sdk/scripts/verify-fixtures.ts
 */
import { hashTypedData, zeroAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  hashOrder,
  typedDataForSigning,
  ORDER_TYPE,
  WITNESS_TYPE_STRING,
  PERMIT2_ADDRESS,
  type Order,
  type Permit2Data,
} from "@seltra/sdk";

// Pinned in contracts/test/OrderHash.t.sol — do not edit without a contracts change.
const EXPECTED_WITNESS_HASH = "0x717f8e5da37156a43f1668adc570a75834280ea423294ae06d004ae8578bd347";
const EXPECTED_PERMIT_DIGEST = "0xa73198c609e2a5ebd586c57df3e40b121675a426c6eb799f89ba4c2756a39ba8";
const EXPECTED_WITNESS_TYPE_STRING =
  "Order witness)Order(address maker,address receiver,address makerAsset,address takerAsset,uint256 makingAmount,uint256 takingAmount,uint256 salt,uint256 epoch,uint40 expiry,address allowedSender,uint8 flags)TokenPermissions(address token,uint256 amount)";

const FIXTURE_SETTLEMENT = "0x00000000000000000000000000000000DeaDBeef" as Address;
const FIXTURE_CHAIN_ID = 43113;
const FIXTURE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const FIXTURE_MAKER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;

const order: Order = {
  maker: FIXTURE_MAKER,
  receiver: FIXTURE_MAKER,
  makerAsset: "0xd00ae08403B9bbb9124bB305C09058E32C39A48c",
  takerAsset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  makingAmount: 10n * 10n ** 18n,
  takingAmount: 400n * 10n ** 6n,
  salt: 12345n,
  epoch: 0n,
  expiry: 1893456000n,
  allowedSender: zeroAddress,
  flags: 0,
};

const permit: Permit2Data = {
  permitted: { token: order.makerAsset, amount: order.makingAmount },
  nonce: 42n,
  deadline: order.expiry,
};

let failures = 0;
function check(name: string, actual: string, expected: string) {
  const ok = actual.toLowerCase() === expected.toLowerCase();
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`      actual:   ${actual}\n      expected: ${expected}`);
    failures += 1;
  }
}

async function main() {
  check("WITNESS_TYPE_STRING matches contract constant", WITNESS_TYPE_STRING, EXPECTED_WITNESS_TYPE_STRING);
  check(
    "witness type string is derived from ORDER_TYPE",
    WITNESS_TYPE_STRING,
    "Order witness)" + ORDER_TYPE + "TokenPermissions(address token,uint256 amount)",
  );
  check("hashOrder matches pinned witness hash", hashOrder(order), EXPECTED_WITNESS_HASH);

  const typedData = typedDataForSigning({
    chainId: FIXTURE_CHAIN_ID,
    permit2: PERMIT2_ADDRESS,
    settlement: FIXTURE_SETTLEMENT,
    order,
    permit,
  });
  check("EIP-712 digest matches pinned permit digest", hashTypedData(typedData), EXPECTED_PERMIT_DIGEST);

  const account = privateKeyToAccount(FIXTURE_KEY);
  const signature = await account.signTypedData(typedData);
  check("fixture key produces a 65-byte signature", String(signature.length), String(2 + 65 * 2));

  console.log(failures === 0 ? "\nSDK is byte-identical with the deployed contracts." : `\n${failures} fixture check(s) FAILED — do not sign orders until resolved.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
