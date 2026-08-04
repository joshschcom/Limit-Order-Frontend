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
import { CandlestickChart } from "lucide-react";
import { pairById } from "@/config/seltra.config";
import { useCandles, useQuote, useQuoteHistory, useVenueQuoteHistory } from "@/lib/market-data";
import { InfoTip } from "@/components/info-tip";
import { displaySymbol, TokenIcon } from "@/components/token-icon";

const INTERVALS: { label: string; seconds: number }[] = [
  { label: "1m", seconds: 60 },
  { label: "5m", seconds: 300 },
  { label: "15m", seconds: 900 },
  { label: "1h", seconds: 3600 },
  { label: "4h", seconds: 14_400 },
  { label: "1D", seconds: 86_400 },
  { label: "1W", seconds: 604_800 },
  { label: "1M", seconds: 2_592_000 },
];

const VENUE_COLORS: Record<string, string> = {
  lfj: "#00bfa5",
  blackhole: "#8b5cf6",
  pharaoh: "#f59e0b",
};

function venueColor(name: string, index: number): string {
  return VENUE_COLORS[name.toLowerCase()] ?? ["#38bdf8", "#fb7185", "#a3e635"][index % 3];
}

/** How far back to look for quote-history samples per selected timeframe. */
const LOOKBACK_MS: Record<number, number> = {
  60: 2 * 3_600_000, // 1m -> 2h
  300: 8 * 3_600_000, // 5m -> 8h
  900: 24 * 3_600_000, // 15m -> 1d
  3_600: 4 * 86_400_000, // 1h -> 4d
  14_400: 14 * 86_400_000, // 4h -> 14d
  86_400: 90 * 86_400_000, // 1D -> 90d
  604_800: 365 * 86_400_000, // 1W -> 1y
  2_592_000: 3 * 365 * 86_400_000, // 1M -> 3y
};

/**
 * Without real candles, the venue-history lines are the entire visible
 * chart — but the query never varied with the selected timeframe, so every
 * button showed the exact same (server-default 24h) raw sample window at
 * native polling resolution. Rounded to a 5-minute bucket so the query key
 * stays stable between polls instead of drifting on every render.
 */
function fromMsForInterval(intervalSeconds: number): number {
  const lookback = LOOKBACK_MS[intervalSeconds] ?? LOOKBACK_MS[3_600];
  const roundTo = 5 * 60_000;
  const anchor = Math.floor(Date.now() / roundTo) * roundTo;
  return anchor - lookback;
}

export function PriceChart({ pairId }: { pairId: string }) {
  const pair = pairById(pairId);
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const marketLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const venueHistorySeriesRef = useRef<Map<string, ISeriesApi<"Line">>>(new Map());
  const venuePriceLinesRef = useRef<IPriceLine[]>([]);
  const quoteRangeRef = useRef<{ min: number; max: number } | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const { data: candles, isLoading } = useCandles(pair.id, intervalSeconds);
  const { data: quote } = useQuote(pair.id);
  const fromMs = fromMsForInterval(intervalSeconds);
  const { data: quoteHistory } = useQuoteHistory(pair.id, fromMs);
  const { data: venueQuoteHistory } = useVenueQuoteHistory(pair.id, fromMs);

  useEffect(() => {
    if (!ref.current) return;
    const venueHistorySeries = venueHistorySeriesRef.current;
    const style = getComputedStyle(document.documentElement);
    setIsReady(false);
    const chart: IChartApi = createChart(ref.current, {
      width: ref.current.clientWidth,
      height: ref.current.clientHeight || 360,
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
        const quoteRange = quoteRangeRef.current;
        if (!info?.priceRange || quoteRange === null) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, quoteRange.min),
            maxValue: Math.max(info.priceRange.maxValue, quoteRange.max),
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
    const resizeObserver = new ResizeObserver(([entry]) => {
      const element = ref.current;
      if (!element) return;
      const width = Math.floor(entry?.contentRect.width ?? element.clientWidth);
      const height = Math.floor(entry?.contentRect.height ?? element.clientHeight);
      if (width > 0 && height > 0) chart.applyOptions({ width, height });
    });
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
    resizeObserver.observe(ref.current);
    setIsReady(true);
    return () => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      marketLineRef.current = null;
      venueHistorySeries.clear();
      venuePriceLinesRef.current = [];
      chart.remove();
    };
  }, []);

  // Tick labels reflect the selected timeframe, not just how much history
  // happens to exist yet: hour-and-below buckets show a clock time, day and
  // above show a date. Without this, lightweight-charts' own auto-formatting
  // shows clock-time ticks any time the visible span is short — which, for a
  // young pair with only a couple of hours of real history, it always is,
  // even with 1D/1W/1M selected.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const showDate = intervalSeconds >= 86_400;
    chart.applyOptions({
      timeScale: {
        tickMarkFormatter: (time: UTCTimestamp) => {
          const date = new Date(time * 1000);
          return showDate
            ? date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
            : date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        },
      },
    });
  }, [intervalSeconds, isReady]);

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
  }, [candles]);

  // Keep the legacy best-price history as a rolling-deployment fallback. Once
  // per-venue history exists, the chart renders the independently colored
  // executable histories instead of a misleading single aggregate line.
  useEffect(() => {
    const line = marketLineRef.current;
    if (!line || !quoteHistory) return;
    if ((venueQuoteHistory?.length ?? 0) > 0) {
      line.setData([]);
      return;
    }
    const points: LineData[] = [];
    let lastSecond = -1;
    for (const point of quoteHistory) {
      const second = Math.floor(point.t / 1000);
      if (second <= lastSecond) continue;
      lastSecond = second;
      points.push({ time: second as UTCTimestamp, value: point.price });
    }
    line.setData(points);
  }, [quoteHistory, venueQuoteHistory]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !venueQuoteHistory) return;
    const grouped = new Map<string, LineData[]>();
    const lastSecond = new Map<string, number>();
    for (const point of venueQuoteHistory) {
      if (!Number.isFinite(point.price) || point.price <= 0) continue;
      const second = Math.floor(point.t / 1000);
      if (second <= (lastSecond.get(point.name) ?? -1)) continue;
      lastSecond.set(point.name, second);
      const points = grouped.get(point.name) ?? [];
      points.push({ time: second as UTCTimestamp, value: point.price });
      grouped.set(point.name, points);
    }

    for (const series of venueHistorySeriesRef.current.values()) series.setData([]);
    for (const [index, [name, points]] of [...grouped.entries()].entries()) {
      let series = venueHistorySeriesRef.current.get(name);
      if (!series) {
        series = chart.addLineSeries({
          color: venueColor(name, index),
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: true,
        });
        venueHistorySeriesRef.current.set(name, series);
      }
      series.setData(points);
    }
  }, [venueQuoteHistory]);

  // Auto-fit the time scale once per interval, not on every 30s poll. The
  // previous version re-fit on every data change, so any pan/zoom the user
  // made snapped back the moment new data arrived. A pending flag, reset when
  // the interval changes, fits once when data for that interval first lands
  // and then leaves the viewport alone until the user switches timeframe.
  const pendingFitRef = useRef(true);
  useEffect(() => {
    pendingFitRef.current = true;
  }, [intervalSeconds]);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !pendingFitRef.current) return;
    const hasData = (candles?.length ?? 0) > 0 || (venueQuoteHistory?.length ?? 0) > 0 || (quoteHistory?.length ?? 0) > 0;
    if (!hasData) return;
    pendingFitRef.current = false;
    chart.timeScale().fitContent();
  }, [candles, venueQuoteHistory, quoteHistory, intervalSeconds]);

  // Current executable prices from every available venue.
  useEffect(() => {
    const series = candleSeriesRef.current;
    if (!series) return;
    for (const line of venuePriceLinesRef.current) {
      series.removePriceLine(line);
    }
    venuePriceLinesRef.current = [];

    const venues = quote
      ? quote.venues.length > 0
        ? quote.venues
        : [{ name: quote.venue, price: quote.price }]
      : [];
    const validVenues = venues.filter((venue) => Number.isFinite(venue.price) && venue.price > 0);
    quoteRangeRef.current = validVenues.length > 0
      ? {
          min: Math.min(...validVenues.map((venue) => venue.price)),
          max: Math.max(...validVenues.map((venue) => venue.price)),
        }
      : null;

    for (const [index, venue] of validVenues.entries()) {
      venuePriceLinesRef.current.push(series.createPriceLine({
        price: venue.price,
        color: venueColor(venue.name, index),
        lineWidth: 1,
        lineStyle: venue.name === quote?.venue ? 0 : 2,
        axisLabelVisible: true,
        title: venue.name,
      }));
    }
  }, [quote]);

  const last = candles?.[candles.length - 1];
  const first = candles?.[0];
  const rangeChange = last && first && first.open > 0 ? ((last.close - first.open) / first.open) * 100 : undefined;
  const hasCandles = (candles?.length ?? 0) > 0;

  return (
    <section className="panel chart-panel">
      <div className="chart-toolbar">
        <div>
          <p className="eyebrow">Market</p>
          {/* Each leg is its own no-wrap flex item so a narrow panel can never
              break the title between a symbol and its slash. */}
          <h2 className="inline-token-value chart-pair-title">
            <span className="inline-token-value"><TokenIcon symbol={pair.base} size={18} /> {displaySymbol(pair.base)}</span>
            <span className="market-switcher-sep">/</span>
            <span className="inline-token-value"><TokenIcon symbol={pair.quote} size={18} /> {displaySymbol(pair.quote)}</span>
          </h2>
          <div className="chart-legend">
            <span><i className="legend-candle" /> {displaySymbol(pair.base)} / {displaySymbol(pair.quote)}</span>
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
          </div>
          {quote && quote.venues.length > 0 ? (
            <div className="chart-venue-legend" aria-label="Venues quoting this pair">
              <span className="venue-legend-label">
                DEX reference · quote size {quote.referenceBaseAmount ?? "1"} {displaySymbol(pair.base)}
                <InfoTip>
                  Each line is a live executable sell quote for the displayed reference size, normalized to the price of
                  one {displaySymbol(pair.base)}. Reference sizes differ by asset to avoid unrealistic price impact. This
                  is not an order and does not change the amount you select. Your actual fill still depends on order size,
                  side, and available liquidity.
                </InfoTip>
              </span>
              {quote.venues.map((venue, index) => (
                <span className={venue.name === quote.venue ? "venue-best" : undefined} key={venue.name}>
                  <i className="legend-venue" style={{ backgroundColor: venueColor(venue.name, index) }} aria-hidden />
                  {venue.name} <b className="number">{venue.price.toFixed(pair.pricePrecision)}</b>
                  {venue.name === quote.venue ? <em className="venue-best-tag">Best</em> : null}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="chart-controls" aria-label="Chart interval">
          <div className="timeframe-controls">
            {INTERVALS.map((item) => (
              <button key={item.label} type="button" className={intervalSeconds === item.seconds ? "active" : ""} onClick={() => setIntervalSeconds(item.seconds)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className={`chart-wrap ${isReady ? "ready" : ""}`}>
        {!isReady || isLoading ? <div className="chart-skeleton" aria-label="Loading price chart"><span /><span /><span /><span /><span /></div> : null}
        {isReady && !isLoading && !hasCandles && (quoteHistory?.length ?? 0) === 0 && (venueQuoteHistory?.length ?? 0) === 0 ? (
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
