import { expect, test } from "@playwright/test";

const STORAGE_KEY = "streampay:theme";

test("settings exposes an accessible theme choice and persists it", async ({ page }) => {
  await page.goto("/settings");

  const appearance = page.getByRole("group", { name: "Appearance" });
  const light = page.getByRole("radio", { name: "Light", exact: true });
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  const system = page.getByRole("radio", { name: "System", exact: true });

  await expect(appearance.getByRole("radio")).toHaveCount(3);
  await expect(system).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await dark.check();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(10, 14, 22)");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("dark");

  await page.reload();
  await expect(dark).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  // Native radio keyboard operation: focus a choice and toggle it with Space.
  await light.focus();
  await page.keyboard.press("Space");
  await expect(light).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByText("Current theme: Light.")).toBeVisible();
});

test("system mode follows prefers-color-scheme while explicit choices do not", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");

  const system = page.getByRole("radio", { name: "System", exact: true });
  const dark = page.getByRole("radio", { name: "Dark", exact: true });
  const light = page.getByRole("radio", { name: "Light", exact: true });
  const root = page.locator("html");

  await expect(system).toBeChecked();
  await expect(root).toHaveAttribute("data-theme", "dark");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "light");

  await dark.check();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveAttribute("data-theme", "dark");

  await system.check();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("system");

  await page.reload();
  await expect(system).toBeChecked();
  await expect(root).toHaveAttribute("data-theme", "dark");
  await expect(light).not.toBeChecked();
});

test("theme choices synchronize across tabs", async ({ page, context }) => {
  const second = await context.newPage();
  await Promise.all([page.goto("/settings"), second.goto("/settings")]);

  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await expect(second.getByRole("radio", { name: "Dark", exact: true })).toBeChecked();
  await expect(second.locator("html")).toHaveAttribute("data-theme", "dark");

  await second.getByRole("radio", { name: "Light", exact: true }).check();
  await expect(page.getByRole("radio", { name: "Light", exact: true })).toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("embed URL themes override app storage and auto follows the system", async ({ page }) => {
  await page.addInitScript((key) => localStorage.setItem(key, "light"), STORAGE_KEY);
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/embed/frame?theme=dark&streamId=1");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "dark");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("light");

  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/embed/frame?theme=light&streamId=1");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await page.goto("/embed/frame?theme=auto&streamId=1");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme-preference", "system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)).toBe("light");
});

for (const scenario of [
  { preference: "dark", system: "dark" as const, expected: "dark", background: "rgb(10, 14, 22)" },
  { preference: "light", system: "dark" as const, expected: "light", background: "rgb(248, 250, 252)" },
  { preference: null, system: "dark" as const, expected: "dark", background: "rgb(10, 14, 22)" },
]) {
  test(`pre-paint script selects ${scenario.preference ?? "system"} before hydration`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scenario.system });
    await page.addInitScript(({ key, preference }) => {
      localStorage.removeItem(key);
      if (preference) localStorage.setItem(key, preference);
    }, { key: STORAGE_KEY, preference: scenario.preference });

    // Block external hydration/runtime scripts. The SSR HTML and blocking inline
    // initializer still render, so a post-hydration fix cannot make this pass.
    await page.route("**/*", (route) =>
      route.request().resourceType() === "script" ? route.abort() : route.continue()
    );

    const response = await page.goto("/settings", { waitUntil: "domcontentloaded" });
    expect(response?.ok()).toBe(true);
    const html = await response!.text();
    expect(html.indexOf(STORAGE_KEY)).toBeGreaterThanOrEqual(0);
    expect(html.indexOf(STORAGE_KEY)).toBeLessThan(html.indexOf("<body"));

    await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.expected);
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme-preference",
      scenario.preference ?? "system"
    );
    await expect(page.locator("body")).toHaveCSS("background-color", scenario.background);
  });
}
