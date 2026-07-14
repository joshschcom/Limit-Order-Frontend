// Nonce scheme: (unix_millis << 64) | random64 — monotonic-ish, collision-free,
// opaque to Permit2. Scattered bitmap words are a deliberate tradeoff (SDK spec §5).

export function generateNonce(): bigint {
  const millis = BigInt(Date.now());
  return (millis << 64n) | random64();
}

export function randomSalt(): bigint {
  return (random64() << 192n) | (random64() << 128n) | (random64() << 64n) | random64();
}

function random64(): bigint {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  return (BigInt(bytes[0]) << 32n) | BigInt(bytes[1]);
}

export function nonceToWordAndMask(nonce: bigint): { wordPos: bigint; mask: bigint } {
  return { wordPos: nonce >> 8n, mask: 1n << (nonce & 0xffn) };
}
