import { NextResponse, type NextRequest } from "next/server";

const isDev = process.env.NODE_ENV !== "production";

function originOf(url: string | undefined, fallback: string): string {
  try {
    return new URL(url && url !== "" ? url : fallback).origin;
  } catch {
    return fallback;
  }
}

// connect-src is derived from the same env the app uses, so pointing the app
// at mainnet endpoints updates the policy without code changes. Static reads
// only — NEXT_PUBLIC_ vars are inlined into the middleware bundle at build.
const connectSrc = [
  "'self'",
  originOf(process.env.NEXT_PUBLIC_API_REST_URL, "http://localhost:8080"),
  originOf(process.env.NEXT_PUBLIC_API_WS_URL, "ws://localhost:8080"),
  originOf(process.env.NEXT_PUBLIC_RPC_URL, "https://api.avax-test.network"),
  // WalletConnect relay/verify/explorer + Coinbase Wallet SDK endpoints.
  "wss://relay.walletconnect.com",
  "wss://relay.walletconnect.org",
  "https://*.walletconnect.com",
  "https://*.walletconnect.org",
  "https://*.coinbase.com",
  "wss://www.walletlink.org",
  ...(isDev ? ["http://localhost:*", "ws://localhost:*"] : []),
].join(" ");

function buildCsp(scriptSrc: string): string {
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "frame-src https://verify.walletconnect.com https://verify.walletconnect.org",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export function middleware(request: NextRequest) {
  // Dev: webpack HMR needs eval and un-nonced inline scripts.
  if (isDev) {
    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", buildCsp("'self' 'unsafe-inline' 'unsafe-eval'"));
    return response;
  }

  // Prod: per-request nonce. Next reads the CSP request header and stamps the
  // nonce onto its own inline scripts; 'strict-dynamic' lets those scripts
  // load the chunk graph. 'self' https: are fallbacks for pre-CSP3 browsers.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const csp = buildCsp(`'nonce-${nonce}' 'strict-dynamic' 'self' https:`);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Documents only: static assets and prefetches don't execute inline scripts.
    {
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
