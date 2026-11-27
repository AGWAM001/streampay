import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import ForecastSummary from "./ForecastSummary";
import StreamProjectionTable from "./StreamProjectionTable";
import TimeSeriesChart from "./TimeSeriesChart";
import {
  buildAggregatedTimeSeries,
  forecastIncome,
  windowFromDays,
  type AnalyticsStream,
} from "@/lib/analytics";
import { FIXED_NOW_SECONDS } from "../../.storybook/fake-clock";
import { TOKEN_CONTRACT, XLM_SAC, activeStream, tokenStream } from "../../.storybook/fixtures";

// Analytics inputs derived from the shared fixtures, and evaluated at the
// frozen instant rather than `Date.now()`, exactly as /analytics feeds them.
const STREAMS: AnalyticsStream[] = [activeStream, tokenStream].map((s) => ({
  id: s.id,
  token: s.token,
  deposit: BigInt(s.deposit),
  withdrawn: BigInt(s.withdrawn),
  startTime: s.startTime,
  endTime: s.endTime,
  status: s.status,
  symbol: s.token === XLM_SAC ? "XLM" : s.token === TOKEN_CONTRACT ? "USDC" : undefined,
}));

const [FROM, TO] = windowFromDays(FIXED_NOW_SECONDS, 14, 14);

/**
 * The chart's own axis formatter (TimeSeriesChart `formatDate`). Repeating the
 * call rather than a hard-coded "Jan 1" keeps the assertion about the plotted
 * window instead of about the browser's locale.
 */
function axisDate(ts: number): string {
  return new Date(ts * 1_000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The /analytics building blocks, fed by the pure functions in lib/analytics. */
const meta = {
  title: "Analytics/Charts",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const AccrualTimeSeries: StoryObj<typeof TimeSeriesChart> = {
  render: (args) => <TimeSeriesChart {...args} />,
  args: {
    title: "XLM accrued vs. claimed",
    points: buildAggregatedTimeSeries([STREAMS[0]], FROM, TO, 60),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const figure = canvas.getByRole("figure", { name: "XLM accrued vs. claimed" });
    const svg = within(figure).getByRole("img", { name: "XLM accrued vs. claimed" });

    // Two series lines plus the filled available area between them.
    await expect(svg.querySelectorAll("path")).toHaveLength(2);
    await expect(svg.querySelector("polygon")).not.toBeNull();
    for (const label of ["Accrued", "Claimed", "Available"]) {
      await expect(within(figure).getByText(label)).toBeVisible();
    }

    // Axis ticks: three value ticks and four date ticks, and the date range
    // spans exactly the requested window end to end (not "now").
    const yTicks = Array.from(svg.querySelectorAll("text[text-anchor='end']"));
    const xTicks = Array.from(svg.querySelectorAll("text[text-anchor='middle']"));
    await expect(yTicks).toHaveLength(3);
    await expect(xTicks).toHaveLength(4);
    await expect(xTicks[0]).toHaveTextContent(axisDate(FROM));
    await expect(xTicks[xTicks.length - 1]).toHaveTextContent(axisDate(TO));
    // A different tick pair, so a chart that repeated one label would fail.
    await expect(xTicks[0]).not.toHaveTextContent(axisDate(TO));
  },
};

/** No points in the window: the chart's empty state. */
export const EmptyTimeSeries: StoryObj<typeof TimeSeriesChart> = {
  render: (args) => <TimeSeriesChart {...args} />,
  args: { title: "No activity", points: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Below two points there is nothing to draw: no plot, just the message.
    await expect(canvas.getByText(/not enough data to render chart/i)).toBeVisible();
    await expect(canvas.queryByRole("img")).not.toBeInTheDocument();
  },
};

export const Forecast: StoryObj<typeof ForecastSummary> = {
  render: (args) => <ForecastSummary {...args} />,
  args: {
    forecast30: forecastIncome(STREAMS, FIXED_NOW_SECONDS, 30),
    forecast90: forecastIncome(STREAMS, FIXED_NOW_SECONDS, 90),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const region = canvas.getByRole("region", { name: /income forecast/i });
    await expect(within(region).getByRole("heading", { name: /income forecast/i })).toBeVisible();

    // Both horizons are labelled and carry a formatted amount in stroops.
    await expect(within(region).getByText("Next 30 days")).toBeVisible();
    await expect(within(region).getByText("Next 90 days")).toBeVisible();
    await expect(within(region).getAllByText("stroops")).toHaveLength(2);
    const amounts = Array.from(region.querySelectorAll("div[style*='1.4rem']"));
    await expect(amounts).toHaveLength(2);
    for (const amount of amounts) {
      await expect(amount).toHaveTextContent(/^[\d.]+[Mk]?$/);
    }

    // Two active tokens in the fixtures: the 30-day breakdown lists both,
    // each truncated to its first eight characters.
    const tokens = within(region).getAllByRole("listitem");
    await expect(tokens).toHaveLength(2);
    const token0 = tokens[0].textContent ?? "";
    const token1 = tokens[1].textContent ?? "";
    await expect(token0).toContain(`${XLM_SAC.slice(0, 8)}…:`);
    await expect(token1).toContain(`${TOKEN_CONTRACT.slice(0, 8)}…:`);
  },
};

export const Projections: StoryObj<typeof StreamProjectionTable> = {
  render: (args) => <StreamProjectionTable {...args} />,
  args: { streams: STREAMS, nowSeconds: FIXED_NOW_SECONDS },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const table = canvas.getByRole("table", { name: /stream projections/i });
    const rows = within(table).getAllByRole("row");
    // Header plus the two fixture streams.
    await expect(rows).toHaveLength(3);

    const bodyRows = rows.slice(1);
    for (const row of bodyRows) {
      await expect(within(row).getAllByRole("cell")).toHaveLength(6);
    }

    // Sorted by projected accrual, descending: the 30-day XLM stream out-earns
    // the 30-day token stream, and each id links to its own stream page.
    const links = bodyRows.map((row) => within(row).getByRole("link"));
    await expect(links[0]).toHaveTextContent("42");
    await expect(links[0]).toHaveAttribute("href", "/stream/42");
    await expect(links[1]).toHaveTextContent("43");
    await expect(links[1]).toHaveAttribute("href", "/stream/43");
  },
};
