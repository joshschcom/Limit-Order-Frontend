import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Seltra — wallet-native limit orders on Avalanche";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const teal = "#2dd4bf";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
          justifyContent: "center",
          padding: "0 96px",
          backgroundColor: "#12141c",
          backgroundImage: "radial-gradient(at 85% 10%, rgba(45,212,191,0.16), transparent 55%)",
          color: "#f4f6fb",
          fontSize: 40,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
          <svg width="96" height="96" viewBox="0 0 48 48" fill="none">
            <path d="M2 19 H18 C25 19 25 7 32 7 H46" stroke={teal} strokeWidth="5" />
            <path d="M2 29 H18 C25 29 25 41 32 41 H46" stroke={teal} strokeWidth="5" />
            <path d="M33 24 H46" stroke={teal} strokeWidth="5" />
            <path d="M21 24 L33 18 V30 Z" fill={teal} />
          </svg>
          <div style={{ display: "flex", fontSize: 92, fontWeight: 700 }}>Seltra</div>
        </div>
        <div style={{ display: "flex", marginTop: 34, fontSize: 42, color: "#c6cddd", maxWidth: 900 }}>
          Wallet-native limit orders on Avalanche
        </div>
        <div style={{ display: "flex", marginTop: 20, fontSize: 26, color: teal }}>
          Gasless signed orders · DEX-routed or P2P fills · Your price or better
        </div>
      </div>
    ),
    size,
  );
}
