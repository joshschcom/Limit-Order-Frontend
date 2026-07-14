import { Activity, ArrowUpRight, BookOpen, PenLine, ShieldCheck, Sparkles } from "lucide-react";
import Link from "next/link";
import { defaultTradePath } from "@/config/seltra.config";
import { LiveStrip } from "@/components/live-strip";
import { ThemeToggle } from "@/components/theme-controls";

export default function HomePage() {
  return (
    <div className="landing-shell">
      <header className="landing-nav">
        <Link className="brand" href="/" aria-label="Seltra home"><span className="brand-mark" /><span className="brand-word">Seltra</span></Link>
        <nav aria-label="Site navigation"><Link href="/docs">Docs</Link><Link href="/stats">Stats</Link><a href="https://github.com" target="_blank" rel="noreferrer">GitHub</a></nav>
        <div className="landing-actions"><ThemeToggle /><Link className="button accent" href={defaultTradePath}>Open app <ArrowUpRight size={16} /></Link></div>
      </header>
      <main>
        <section className="landing-hero">
          <div className="route-strand" aria-hidden="true"><span /><span /></div>
          <div className="hero-copy">
            <span className="hero-kicker"><i /> Precision execution on Avalanche</span>
            <h1>Limit orders that live in your wallet.</h1>
            <p>Gasless signed orders, filled by aggregated DEX liquidity or another Seltra trader. You always get your price or better.</p>
            <div className="hero-actions"><Link className="button accent hero-primary" href={defaultTradePath}>Open app <ArrowUpRight size={17} /></Link><Link className="button ghost" href="/docs">Read the specs</Link></div>
            <span className="network-chip hero-network">Avalanche C-Chain</span>
          </div>
          <div className="landing-terminal" aria-label="Seltra terminal preview">
            <div className="landing-terminal-bar"><span className="terminal-pair">WAVAX / USDC</span><span className="preview-live"><i /> Terminal preview</span><span className="number buy">+2.14%</span></div>
            <div className="landing-terminal-body">
              <div className="preview-chart"><div className="preview-grid" /><div className="preview-candles"><i /><i /><i /><i /><i /><i /><i /></div><span className="preview-lfj">LFJ $40.03</span></div>
              <div className="preview-book"><span>RESTING BOOK</span><b className="sell number">41.20</b><b className="sell number">40.92</b><b className="lfj-preview number">40.03</b><b className="buy number">39.82</b><b className="buy number">39.51</b></div>
              <div className="preview-ticket"><span>LIMIT ORDER</span><div className="preview-tabs"><b>Buy</b><b>Sell</b></div><i>Amount</i><i>Limit price</i><strong className="number">10 WAVAX</strong><em>Connect wallet</em></div>
            </div>
          </div>
        </section>
        <LiveStrip />
        <section className="landing-section how-it-works">
          <div className="section-intro"><p className="eyebrow">Execution without custody</p><h2>Keep control from order to settlement.</h2></div>
          <div className="feature-grid">
            <article><PenLine size={20} /><h3>Sign, don&apos;t send.</h3><p>One signature places your order. No deposit and no locked funds.</p></article>
            <article><Activity size={20} /><h3>Two ways to fill.</h3><p>Keepers source LFJ liquidity or Seltra matches a crossing order directly.</p></article>
            <article><ShieldCheck size={20} /><h3>Your price or better.</h3><p>Contract rules prevent fills below your limit. You receive 70% of surplus.</p></article>
          </div>
        </section>
        <section className="landing-section trust-section">
          <div className="section-intro"><p className="eyebrow">Security model</p><h2>Clear settlement rules. No hidden custody.</h2></div>
          <div className="trust-grid">
            <div><Sparkles size={18} /><h3>No standing approvals to Seltra</h3><p>Token movement happens only through Permit2 and your signed order.</p></div>
            <div><ShieldCheck size={18} /><h3>Immutable settlement</h3><p>No proxy or upgrade key controls your orders.</p></div>
            <div><BookOpen size={18} /><h3>Cancel anytime</h3><p>Cancel one order or invalidate every open order in one transaction.</p></div>
          </div>
          <Link className="text-link" href="/docs">Read the security model <ArrowUpRight size={15} /></Link>
        </section>
      </main>
      <footer className="landing-footer"><span className="footer-brand">Seltra</span><span>Wallet-native limit orders</span><span className="network-chip">Built on Avalanche</span><Link href={defaultTradePath}>Launch terminal <ArrowUpRight size={14} /></Link></footer>
    </div>
  );
}
