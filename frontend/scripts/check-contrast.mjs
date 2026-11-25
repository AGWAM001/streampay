#!/usr/bin/env node
/**
 * WCAG AA contrast gate for the semantic theme tokens.
 *
 * Usage:
 *   node scripts/check-contrast.mjs
 *   node scripts/check-contrast.mjs --self-test
 *   node scripts/check-contrast.mjs --pair '#777777:#ffffff:4.5'
 *
 * The pair mode exits 1 on failure. --self-test proves that contract by
 * spawning this script with a known failing pair, then checks a passing pair.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const TOKEN_FILE = fileURLToPath(new URL("../app/theme.css", import.meta.url));

function parseHex(value) {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(value.trim());
  if (!match) throw new Error(`Expected an opaque hex color, received ${value}`);
  const hex = match[1].length === 3
    ? [...match[1]].map((digit) => digit + digit).join("")
    : match[1];
  const number = Number.parseInt(hex, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}

function relativeLuminance(color) {
  const channels = parseHex(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export function evaluatePair(foreground, background, minimum) {
  const ratio = contrastRatio(foreground, background);
  return { ratio, passes: ratio + Number.EPSILON >= minimum, minimum };
}

function readTokenBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`Missing token selector ${selector}`);
  const tokens = {};
  for (const declaration of match[1].split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const name = declaration.slice(0, separator).trim();
    if (name.startsWith("--")) tokens[name] = declaration.slice(separator + 1).trim();
  }
  return tokens;
}

const TEXT_SURFACES = [
  "surface-canvas",
  "surface-raised",
  "surface-hover",
  "surface-inset",
  "surface-subtle",
  "surface-selected",
  "surface-chart",
  "surface-row-alt",
  "surface-batch-start",
  "surface-batch-end",
  "accent-subtle",
  "accent-subtle-soft",
  "status-success-subtle",
  "status-warning-subtle",
  "status-danger-subtle",
  "status-info-subtle",
];

const COMMON_SURFACES = TEXT_SURFACES.slice(0, 10);
const CONTROL_SURFACES = [...COMMON_SURFACES, "accent-subtle", "accent-subtle-soft"];

const PAIRS = [
  // Body and secondary text on every opaque semantic surface.
  ...TEXT_SURFACES.flatMap((surface) => [
    ["foreground-default", surface, 4.5],
    ["foreground-muted", surface, 4.5],
  ]),
  // Accent, status, and emphasis text on common surfaces.
  ...[
    "accent-primary",
    "accent-primary-hover",
    "accent-secondary",
    "accent-secondary-hover",
    "status-success",
    "status-warning",
    "status-danger",
    "status-info",
    "foreground-danger-emphasis",
  ].flatMap((foreground) =>
    COMMON_SURFACES.map((surface) => [foreground, surface, 4.5])
  ),
  // Pairings used by badges, notices, forecast chips, and selected rows.
  ["accent-primary", "accent-subtle", 4.5],
  ["accent-primary", "accent-subtle-soft", 4.5],
  ["accent-secondary", "accent-subtle", 4.5],
  ["accent-secondary", "accent-subtle-soft", 4.5],
  ["status-success", "status-success-subtle", 4.5],
  ["status-warning", "status-warning-subtle", 4.5],
  ["status-danger", "status-danger-subtle", 4.5],
  ["foreground-danger-emphasis", "status-danger-subtle", 4.5],
  ["status-info", "status-info-subtle", 4.5],
  ["status-info", "accent-subtle", 4.5],
  ["accent-secondary", "status-info-subtle", 4.5],
  ["status-success", "status-info-subtle", 4.5],
  // Gradient heading endpoints are text colors too.
  ...["heading-accent-start", "heading-accent-end"].map((foreground) => [
    foreground,
    "surface-canvas",
    4.5,
  ]),
  // Filled controls and badges: check both gradient endpoints and hover states.
  ["foreground-on-accent", "accent-strong", 4.5],
  ["foreground-on-accent", "accent-secondary-strong", 4.5],
  ["foreground-on-accent", "accent-strong-hover", 4.5],
  ["foreground-on-accent", "accent-secondary-strong-hover", 4.5],
  ["foreground-on-badge", "accent-strong", 4.5],
  ["foreground-on-success", "status-success-button", 4.5],
  ["foreground-on-success", "status-success-button-end", 4.5],
  ["foreground-on-danger", "status-danger-button", 4.5],
  ["foreground-on-danger", "status-danger-button-end", 4.5],
  // Control boundaries (WCAG 1.4.11) and focus indicators (WCAG 2.4.11).
  ...CONTROL_SURFACES.map((surface) => ["border-control", surface, 3]),
  ...TEXT_SURFACES.map((surface) => ["focus-ring-color", surface, 3]),
  ["focus-ring-inner", "focus-ring-color", 3],
  // Meaningful chart and simulator lines (WCAG 1.4.11).
  ...[
    "chart-accrued",
    "chart-claimed",
    "accent-primary",
    "accent-secondary",
    "status-success",
    "status-danger",
  ].map((foreground) => [foreground, "surface-chart", 3]),
];

function tokenName(name) {
  return `--${name}`;
}

function audit() {
  const css = readFileSync(TOKEN_FILE, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const palettes = {
    light: readTokenBlock(css, ":root"),
    dark: readTokenBlock(css, '[data-theme="dark"]'),
  };
  const failures = [];
  let checked = 0;

  for (const [theme, tokens] of Object.entries(palettes)) {
    for (const [foreground, background, minimum] of PAIRS) {
      const foregroundToken = tokenName(foreground);
      const backgroundToken = tokenName(background);
      if (!(foregroundToken in tokens) || !(backgroundToken in tokens)) {
        failures.push(`${theme}: missing ${foregroundToken} or ${backgroundToken}`);
        continue;
      }
      let result;
      try {
        result = evaluatePair(tokens[foregroundToken], tokens[backgroundToken], minimum);
      } catch (error) {
        failures.push(`${theme}: ${foregroundToken} on ${backgroundToken}: ${error.message}`);
        continue;
      }
      checked += 1;
      if (!result.passes) {
        failures.push(
          `${theme}: ${foregroundToken} (${tokens[foregroundToken]}) on ` +
          `${backgroundToken} (${tokens[backgroundToken]}) = ${result.ratio.toFixed(2)}:1; ` +
          `requires ${minimum}:1`
        );
      }
    }
  }

  if (failures.length) {
    console.error(`Theme contrast audit failed (${failures.length} problem(s)):\n${failures.join("\n")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Theme contrast audit passed: ${checked} light/dark token pairs meet WCAG AA.`);
}

function runPair(specification) {
  const [foreground, background, minimum, ...extra] = specification.split(":");
  assert.equal(extra.length, 0, "pair format is foreground:background:minimum");
  const threshold = Number(minimum);
  assert.ok(Number.isFinite(threshold) && threshold > 0, "minimum must be a positive number");
  const result = evaluatePair(foreground, background, threshold);
  console.log(
    `${result.passes ? "PASS" : "FAIL"} ${foreground} on ${background}: ` +
    `${result.ratio.toFixed(2)}:1 (requires ${threshold}:1)`
  );
  if (!result.passes) process.exitCode = 1;
}

function selfTest() {
  assert.ok(Math.abs(contrastRatio("#000000", "#ffffff") - 21) < 1e-10);
  assert.equal(evaluatePair("#777777", "#ffffff", 4.5).passes, false);

  const failing = spawnSync(process.execPath, [SCRIPT, "--pair", "#777777:#ffffff:4.5"], {
    encoding: "utf8",
  });
  assert.equal(failing.status, 1, "a failing pair must exit nonzero");
  assert.match(failing.stdout, /FAIL/);

  const passing = spawnSync(process.execPath, [SCRIPT, "--pair", "#000000:#ffffff:4.5"], {
    encoding: "utf8",
  });
  assert.equal(passing.status, 0, "a passing pair must exit zero");
  assert.match(passing.stdout, /PASS/);
  console.log("Contrast self-test passed: known failing pair exited 1; known passing pair exited 0.");
}

const args = process.argv.slice(2);
if (args.includes("--self-test")) selfTest();
const pairIndex = args.indexOf("--pair");
if (pairIndex >= 0) {
  assert.ok(args[pairIndex + 1], "--pair requires foreground:background:minimum");
  runPair(args[pairIndex + 1]);
} else if (!args.includes("--self-test")) {
  audit();
}
