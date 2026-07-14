"use client";

import {
  createChart,
  ColorType,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { Camera, CandlestickChart, Maximize2 } from "lucide-react";
import { pairById } from "@/config/seltra.config";
import { useCandles, useQuote, useQuoteHistory } from "@/lib/market-data";

const INTERVALS: { label: string; seconds: number }[] = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14_400 },
  { label: "1D", seconds: 86_400 },
];

export function PriceChart({ pairId }: { pairId: string }) {
  const pair = pairById(pairId);
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const marketLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const quoteLineRef = useRef<IPriceLine | null>(null);
  const quotePriceRef = useRef<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const { data: candles, isLoading } = useCandles(pair.id, intervalSeconds);
  const { data: quote } = useQuote(pair.id);
  const { data: quoteHistory } = useQuoteHistory(pair.id);

  useEffect(() => {
    if (!ref.current) return;
    const style = getComputedStyle(document.documentElement);
    setIsReady(false);
    const chart: IChartApi = createChart(ref.current, {
      height: 366,
      layout: {
        background: { type: ColorType.Solid, color: style.getPropertyValue("--bg-base").trim() },
        textColor: style.getPropertyValue("--text-2").trim(),
      },
      grid: {
        vertLines: { color: style.getPropertyValue("--chart-grid").trim() },
        horzLines: { color: style.getPropertyValue("--chart-grid").trim() },
      },
      rightPriceScale: { borderColor: style.getPropertyValue("--border-subtle").trim(), scaleMargins: { top: 0.08, bottom: 0.21 }, minimumWidth: 58 },
      timeScale: { borderColor: style.getPropertyValue("--border-subtle").trim(), timeVisible: true, secondsVisible: false, barSpacing: 11, minBarSpacing: 2, rightOffset: 3 },
      crosshair: { vertLine: { color: style.getPropertyValue("--border-strong").trim(), width: 1, style: 2, labelBackgroundColor: style.getPropertyValue("--bg-overlay").trim() }, horzLine: { color: style.getPropertyValue("--border-strong").trim(), width: 1, style: 2, labelBackgroundColor: style.getPropertyValue("--bg-overlay").trim() } },
    });
    const series = chart.addCandlestickSeries({
      upColor: style.getPropertyValue("--buy").trim(),
      downColor: style.getPropertyValue("--sell").trim(),
      borderVisible: false,
      wickUpColor: style.getPropertyValue("--buy").trim(),
      wickDownColor: style.getPropertyValue("--sell").trim(),
      // Price lines don't autoscale by default; stretch the range so the
      // executable-quote line is always on screen.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const info = original();
        const quotePrice = quotePriceRef.current;
        if (!info?.priceRange || quotePrice === null) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, quotePrice),
            maxValue: Math.max(info.priceRange.maxValue, quotePrice),
          },
        };
      },
    });
    const volume = chart.addHistogramSeries({ priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.75, bottom: 0.04 }, visible: false });
    // Observed market price (sampled router quotes) behind the fill candles.
    const marketLine = chart.addLineSeries({
      color: style.getPropertyValue("--accent-soft").trim() || style.getPropertyValue("--accent").trim(),
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chartRef.current = chart;
    candleSeriesRef.current = series;
    volumeSeriesRef.current = volume;
    marketLineRef.current = marketLine;
    const resize = () => chart.applyOptions({ width: ref.current?.clientWidth ?? 0 });
    const updatePalette = () => {
      const nextStyle = getComputedStyle(document.documentElement);
      chart.applyOptions({
        layout: { background: { type: ColorType.Solid, color: nextStyle.getPropertyValue("--bg-base").trim() }, textColor: nextStyle.getPropertyValue("--text-2").trim() },
        grid: { vertLines: { color: nextStyle.getPropertyValue("--chart-grid").trim() }, horzLines: { color: nextStyle.getPropertyValue("--chart-grid").trim() } },
        rightPriceScale: { borderColor: nextStyle.getPropertyValue("--border-subtle").trim() },
        timeScale: { borderColor: nextStyle.getPropertyValue("--border-subtle").trim() },
      });
      series.applyOptions({ upColor: nextStyle.getPropertyValue("--buy").trim(), downColor: nextStyle.getPropertyValue("--sell").trim(), wickUpColor: nextStyle.getPropertyValue("--buy").trim(), wickDownColor: nextStyle.getPropertyValue("--sell").trim() });
      marketLine.applyOptions({ color: nextStyle.getPropertyValue("--accent-soft").trim() || nextStyle.getPropertyValue("--accent").trim() });
    };
    const themeObserver = new MutationObserver(updatePalette);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    resize();
    setIsReady(true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      themeObserver.disconnect();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      marketLineRef.current = null;
      quoteLineRef.current = null;
      chart.remove();
    };
  }, []);

  // Data feed: real fill-backed candles only; an empty book stays empty.
  useEffect(() => {
    const series = candleSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!series || !volume || !candles) return;
    const style = getComputedStyle(document.documentElement);
    const buyMuted = style.getPropertyValue("--buy-muted").trim() || style.getPropertyValue("--buy").trim();
    const sellMuted = style.getPropertyValue("--sell-muted").trim() || style.getPropertyValue("--sell").trim();
    series.setData(
      candles.map((candle): CandlestickData => ({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    );
    volume.setData(
      candles.map((candle): HistogramData => ({
        time: candle.time as UTCTimestamp,
        value: candle.volume,
        color: candle.close >= candle.open ? buyMuted : sellMuted,
      })),
    );
    const timeScale = chartRef.current?.timeScale();
    if (candles.length >= 8) {
      timeScale?.fitContent();
    } else if (candles.length > 0) {
      // fitContent with a handful of candles stretches each bar across the pane;
      // pin a normal bar width and keep the bars near the right edge instead.
      timeScale?.applyOptions({ barSpacing: 12 });
      timeScale?.setVisibleLogicalRange({ from: candles.length - 30, to: candles.length + 4 });
    }
  }, [candles]);

  // Sampled market-price line: one point per observed quote, deduped per second,
  // gaps left as gaps. Continuous context even when the fill tape is sparse.
  useEffect(() => {
    const line = marketLineRef.current;
    if (!line || !quoteHistory) return;
    const points: LineData[] = [];
    let lastSecond = -1;
    for (const point of quoteHistory) {
      const second = Math.floor(point.t / 1000);
      if (second <= lastSecond) continue;
      lastSecond = second;
      points.push({ time: second as UTCTimestamp, value: point.price });
    }
    line.setData(points);
  }, [quoteHistory]);

  // Executable-price line from the router quote (venue-labeled), absent when no venue quotes.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    quotePriceRef.current = quote?.price ?? null;
    if (quoteLineRef.current) {
      series.removePriceLine(quoteLineRef.current);
      quoteLineRef.current = null;
    }
    if (quote) {
      const style = getComputedStyle(document.documentElement);
      quoteLineRef.current = series.createPriceLine({
        price: quote.price,
        color: style.getPropertyValue("--accent").trim(),
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: quote.venue,
      });
    }
  }, [quote]);

  function downloadSnapshot() {
    const canvas = chartRef.current?.takeScreenshot();
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    link.download = `seltra-${pair.id.toLowerCase()}.png`;
    link.click();
  }

  const last = candles?.[candles.length - 1];
  const first = candles?.[0];
  const rangeChange = last && first && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : undefined;
  const hasCandles = (candles?.length ?? 0) > 0;

  return (
    <section className="panel chart-panel">
      <div className="chart-toolbar">
        <div>
          <p className="eyebrow">Market</p>
          <h2>{pair.base} / {pair.quote}</h2>
          <div className="chart-legend">
            <span><i className="legend-candle" /> {pair.base} / {pair.quote}</span>
            {last ? (
              <span className="number">
                O {last.open.toFixed(pair.pricePrecision)}&nbsp;&nbsp;H {last.high.toFixed(pair.pricePrecision)}&nbsp;&nbsp;L {last.low.toFixed(pair.pricePrecision)}&nbsp;&nbsp;C {last.close.toFixed(pair.pricePrecision)}
              </span>
            ) : (
              <span className="number">No fills yet</span>
            )}
            {rangeChange !== undefined ? (
              <span className={`number chart-change ${rangeChange < 0 ? "down" : ""}`}>{rangeChange >= 0 ? "+" : ""}{rangeChange.toFixed(2)}%</span>
            ) : null}
            {quote ? <span><i className="legend-lfj" /> {quote.venue} {quote.price.toFixed(pair.pricePrecision)}</span> : null}
          </div>
        </div>
        <div className="chart-controls" aria-label="Chart interval">
          <div className="timeframe-controls">
            {INTERVALS.map((item) => (
              <button key={item.label} type="button" className={intervalSeconds === item.seconds ? "active" : ""} onClick={() => setIntervalSeconds(item.seconds)}>
                {item.label}
              </button>
            ))}
          </div>
          <button className="toolbar-icon" type="button" title="Fullscreen" aria-label="Fullscreen chart" onClick={() => ref.current?.parentElement?.requestFullscreen?.()}><Maximize2 size={14} /></button>
          <button className="toolbar-icon" type="button" title="Download chart" aria-label="Download chart" onClick={downloadSnapshot}><Camera size={14} /></button>
        </div>
      </div>
      <div className={`chart-wrap ${isReady ? "ready" : ""}`}>
        {!isReady || isLoading ? <div className="chart-skeleton" aria-label="Loading price chart"><span /><span /><span /><span /><span /></div> : null}
        {isReady && !isLoading && !hasCandles && (quoteHistory?.length ?? 0) === 0 ? (
          <div className="chart-empty">
            <CandlestickChart size={20} />
            <strong>No fills yet</strong>
            <span>Candles are built from settled fills only. The first on-chain fill starts the chart.</span>
          </div>
        ) : null}
        <div className="chart-canvas" ref={ref} />
      </div>
    </section>
  );
}
