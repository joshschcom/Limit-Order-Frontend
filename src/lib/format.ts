import { formatUnits } from "viem";

// Rendering with the browser's default locale causes SSR hydration mismatches.
const displayLocale = "en-US";

export function compactAddress(address?: string): string {
  if (!address) return "";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function formatToken(value: bigint, decimals: number, precision = 4): string {
  const raw = formatUnits(value, decimals);
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return n.toLocaleString(displayLocale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: precision,
  });
}

export function formatNumber(value: number, precision = 2): string {
  return value.toLocaleString(displayLocale, {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  });
}
