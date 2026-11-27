/**
 * One full-page screenshot per story, compared against the committed
 * baseline in visual/__screenshots__/linux/<story-id>.png.
 */

import { expect, test } from "@playwright/test";
import {
  loadStories,
  projectTheme,
  renderStory,
  snapshotName,
} from "./storybook";

for (const story of loadStories()) {
  test(`${story.title} › ${story.name}`, async ({ page }, testInfo) => {
    const theme = projectTheme(testInfo.project.name);
    await renderStory(page, story.id, theme);
    await expect(page).toHaveScreenshot(snapshotName(story.id, theme), { fullPage: true });
  });
}
