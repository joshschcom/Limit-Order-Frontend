import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "@/providers";

export const metadata: Metadata = {
  title: "Seltra",
  description: "Wallet-native limit orders on Avalanche.",
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
