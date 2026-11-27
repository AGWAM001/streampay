import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import { AgentListPanel } from "./AgentListPanel";
import { AmendmentPanel } from "./AmendmentPanel";
import { BYSTANDER, RECIPIENT, REFUND_TARGET } from "../.storybook/fixtures";

/**
 * Two small panels that are not wired into a route yet. They are written
 * against Tailwind class names the app does not ship, so what renders here is
 * exactly what they would look like if mounted today — which is the point of
 * keeping a baseline for them.
 *
 * Interaction coverage: neither panel has an expand/collapse control or a tab
 * strip — each renders a single section — so the play functions below drive
 * the interactions the components actually implement: adding and removing an
 * authorized agent, and editing then applying an amendment or a partial
 * cancel. Every play function finishes in the state the baseline captured
 * (agent field empty, original rate/end time, nothing focused), so the
 * byte-exact visual gate still matches.
 */

/** Drops focus so a focus ring cannot end up in the screenshot. */
function blurActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
}

const ORIGINAL_RATE = "11574";
const ORIGINAL_END_TIME = "1770206400";

const meta = {
  title: "Streams/Panels",
  tags: ["autodocs"],
} satisfies Meta;

export default meta;

export const AgentListEmpty: StoryObj<typeof AgentListPanel> = {
  render: (args) => <AgentListPanel {...args} />,
  args: { streamId: "42", agents: [], onAddAgent: fn(), onRemoveAgent: fn() },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/no agents authorized/i)).toBeVisible();

    // An empty field is not a valid address: Add Agent must stay a no-op.
    await userEvent.click(canvas.getByRole("button", { name: /add agent/i }));
    await expect(args.onAddAgent).not.toHaveBeenCalled();

    const input = canvas.getByPlaceholderText(/agent address/i);
    await userEvent.type(input, RECIPIENT);
    await userEvent.click(canvas.getByRole("button", { name: /add agent/i }));
    await waitFor(() => expect(args.onAddAgent).toHaveBeenCalledWith(RECIPIENT));
    // The field clears after a successful add, ready for the next address —
    // which is also the empty state the baseline was captured in.
    await expect(input).toHaveValue("");
    blurActiveElement();
  },
};

export const AgentListPopulated: StoryObj<typeof AgentListPanel> = {
  render: (args) => <AgentListPanel {...args} />,
  args: {
    streamId: "42",
    agents: [BYSTANDER, REFUND_TARGET],
    onAddAgent: fn(),
    onRemoveAgent: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole("listitem");
    await expect(rows).toHaveLength(2);
    await expect(within(rows[0]).getByText(BYSTANDER)).toBeVisible();
    await expect(within(rows[1]).getByText(REFUND_TARGET)).toBeVisible();
    await expect(canvas.queryByText(/no agents authorized/i)).not.toBeInTheDocument();

    // Remove is scoped to its own row: only the clicked agent is removed.
    await userEvent.click(within(rows[0]).getByRole("button", { name: /remove/i }));
    await expect(args.onRemoveAgent).toHaveBeenCalledTimes(1);
    await expect(args.onRemoveAgent).toHaveBeenCalledWith(BYSTANDER);
    await expect(args.onRemoveAgent).not.toHaveBeenCalledWith(REFUND_TARGET);
    blurActiveElement();
  },
};

export const Amendment: StoryObj<typeof AmendmentPanel> = {
  render: (args) => <AmendmentPanel {...args} />,
  args: {
    streamId: "42",
    currentRate: ORIGINAL_RATE,
    currentEndTime: ORIGINAL_END_TIME,
    onApplyAmendment: fn(),
    onPartialCancel: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    // The labels are not associated with their inputs (`htmlFor`), so the two
    // textboxes are addressed by order: rate first, end time second.
    const [rate, endTime] = canvas.getAllByRole("textbox");
    await expect(rate).toHaveValue(ORIGINAL_RATE);
    await expect(endTime).toHaveValue(ORIGINAL_END_TIME);

    await userEvent.clear(rate);
    await userEvent.type(rate, "20000");
    await userEvent.clear(endTime);
    await userEvent.type(endTime, "1771000000");

    // Apply sends both edited values and nothing else.
    await userEvent.click(
      canvas.getByRole("button", { name: /apply rate & end amendment/i })
    );
    await expect(args.onApplyAmendment).toHaveBeenCalledTimes(1);
    await expect(args.onApplyAmendment).toHaveBeenCalledWith("20000", "1771000000");
    await expect(args.onPartialCancel).not.toHaveBeenCalled();

    // Partial cancel reuses the end time currently in the form.
    await userEvent.click(
      canvas.getByRole("button", { name: /partial cancel/i })
    );
    await expect(args.onPartialCancel).toHaveBeenCalledWith("1771000000");

    // Restore the values the story renders at rest, so the screenshot still
    // matches the committed baseline.
    await userEvent.clear(rate);
    await userEvent.type(rate, ORIGINAL_RATE);
    await userEvent.clear(endTime);
    await userEvent.type(endTime, ORIGINAL_END_TIME);
    await expect(rate).toHaveValue(ORIGINAL_RATE);
    await expect(endTime).toHaveValue(ORIGINAL_END_TIME);
    blurActiveElement();
  },
};
