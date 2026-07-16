import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/providers";

const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Seltra",
  description: "Wallet-native limit orders on Avalanche.",
  openGraph: {
    title: "Seltra — wallet-native limit orders on Avalanche",
    description:
      "Gasless signed orders, filled by aggregated DEX liquidity or matched trader-to-trader. Your price or better, always from your wallet.",
    url: appUrl,
    siteName: "Seltra",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Seltra — wallet-native limit orders on Avalanche",
    description:
      "Gasless signed orders, filled by aggregated DEX liquidity or matched trader-to-trader. Your price or better.",
  },
};

// Every page renders per-request so Next can stamp the middleware's CSP nonce
// onto its inline scripts; prerendered HTML would ship un-nonced scripts.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" data-density="balanced" suppressHydrationWarning>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
