#!/usr/bin/env node
/**
 * Raw-color gate for themed UI source. Color literals belong in app/theme.css;
 * app/components/lib/Storybook consume semantic custom properties instead.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOTS = ["app", "components", "lib", ".storybook"].map((directory) => path.join(ROOT, directory));
const EXTENSIONS = new Set([".tsx", ".ts", ".css"]);
const TEST_FILE = /\.(?:test|spec)\.[^.]+$/;
const ALLOWED_LITERALS = new Set([path.join(ROOT, "app", "theme.css")]);
// Social cards are static images, and QR codes need fixed scanner-safe inks
// with a white quiet zone in either theme; neither is themed browser chrome.
const NON_THEMED_FILES = [
  /[/\\]opengraph-image\.tsx$/,
  /[/\\]lib[/\\]share\.ts$/,
];

const NAMED_COLORS = `aliceblue|antiquewhite|aqua|aquamarine|azure|beige|bisque|black|blanchedalmond|blue|blueviolet|brown|burlywood|cadetblue|chartreuse|chocolate|coral|cornflowerblue|cornsilk|crimson|cyan|darkblue|darkcyan|darkgoldenrod|darkgray|darkgreen|darkgrey|darkkhaki|darkmagenta|darkolivegreen|darkorange|darkorchid|darkred|darksalmon|darkseagreen|darkslateblue|darkslategray|darkslategrey|darkturquoise|darkviolet|deeppink|deepskyblue|dimgray|dimgrey|dodgerblue|firebrick|floralwhite|forestgreen|fuchsia|gainsboro|ghostwhite|gold|goldenrod|gray|green|greenyellow|grey|honeydew|hotpink|indianred|indigo|ivory|khaki|lavender|lavenderblush|lawngreen|lemonchiffon|lightblue|lightcoral|lightcyan|lightgoldenrodyellow|lightgray|lightgreen|lightgrey|lightpink|lightsalmon|lightseagreen|lightskyblue|lightslategray|lightslategrey|lightsteelblue|lightyellow|lime|limegreen|linen|magenta|maroon|mediumaquamarine|mediumblue|mediumorchid|mediumpurple|mediumseagreen|mediumslateblue|mediumspringgreen|mediumturquoise|mediumvioletred|midnightblue|mintcream|mistyrose|moccasin|navajowhite|navy|oldlace|olive|olivedrab|orange|orangered|orchid|palegoldenrod|palegreen|paleturquoise|palevioletred|papayawhip|peachpuff|peru|pink|plum|powderblue|purple|rebeccapurple|red|rosybrown|royalblue|saddlebrown|salmon|sandybrown|seagreen|seashell|sienna|silver|skyblue|slateblue|slategray|slategrey|snow|springgreen|steelblue|tan|teal|thistle|tomato|turquoise|violet|wheat|white|whitesmoke|yellow|yellowgreen`;

const TAILWIND_PALETTES = `slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose`;
const TAILWIND_COLOR_UTILITY = new RegExp(
  `\\b(?:bg|text|border(?:-[trblxyse])?|from|via|to|shadow|ring(?:-offset)?|outline|divide|placeholder|decoration|accent|caret|fill|stroke)-(?:${TAILWIND_PALETTES})(?:-(?:50|[1-9]00|950))?(?:\\/\\d{1,3})?(?:$|[\\s"'\`])`,
  "i"
);
const TAILWIND_NAMED_LITERAL = new RegExp(
  `\\b(?:bg|text|border(?:-[trblxyse])?|from|via|to|shadow|ring(?:-offset)?|outline|divide|placeholder|decoration|accent|caret|fill|stroke)-\\[(?:${NAMED_COLORS})\\](?:$|[\\s"'\`])`,
  "i"
);
const TAILWIND_FIXED_INK = new RegExp(
  `\\b(?:bg|text|border(?:-[trblxyse])?|from|via|to|shadow|ring(?:-offset)?|outline|divide|placeholder|decoration|accent|caret|fill|stroke)-(?:black|white)(?:$|[\\s"'\`])`,
  "i"
);

const RAW_COLOR = [
  /#[\da-f]{3,8}\b/i,
  /\b(?:rgba?|hsla?|oklch|oklab|color-mix|lab|lch|hwb|color)\s*\(/i,
  new RegExp(`["'](?:${NAMED_COLORS})["']`, "i"),
  new RegExp(
    `(?:color|background|background-color|border(?:-[a-z]+)?|outline(?:-color)?|fill|stroke|accent-color|caret-color|text-decoration-color|box-shadow)\\s*:\\s*(?:[^;{}]*?\\s)?(?:${NAMED_COLORS})\\b`,
    "i"
  ),
  TAILWIND_COLOR_UTILITY,
  TAILWIND_NAMED_LITERAL,
  TAILWIND_FIXED_INK,
];

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(fullPath);
    if (TEST_FILE.test(entry.name) || !EXTENSIONS.has(path.extname(entry.name))) return [];
    return [fullPath];
  });
}

/** Replace comments with whitespace while preserving line numbers and strings. */
export function stripComments(source) {
  let result = "";
  let state = "code";
  let quote = "";

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === "line-comment") {
      if (character === "\n" || character === "\r") {
        result += character;
        state = "code";
      } else {
        result += " ";
      }
      continue;
    }

    if (state === "block-comment") {
      if (character === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else {
        result += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }

    result += character;
    if (state === "code" && character === "/" && next === "/") {
      result = result.slice(0, -1) + "  ";
      index += 1;
      state = "line-comment";
    } else if (state === "code" && character === "/" && next === "*") {
      result = result.slice(0, -1) + "  ";
      index += 1;
      state = "block-comment";
    } else if (character === quote && character !== "") {
      state = "code";
      quote = "";
    } else if (state === "code" && (character === "'" || character === '"' || character === "`")) {
      state = "string";
      quote = character;
    } else if (state === "string" && character === "\\") {
      result += next ?? "";
      index += 1;
    }
  }

  return result;
}

export function findRawColors(source, file = "source.tsx") {
  if (ALLOWED_LITERALS.has(file) || NON_THEMED_FILES.some((pattern) => pattern.test(file))) return [];
  const withoutComments = stripComments(source);
  const violations = [];
  withoutComments.split("\n").forEach((line, index) => {
    if (RAW_COLOR.some((pattern) => pattern.test(line))) {
      violations.push(`${path.relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
    }
  });
  return violations;
}

function selfTest() {
  const component = path.join(ROOT, "components", "sample.tsx");
  const helper = path.join(ROOT, "lib", "sample.ts");
  const hex = findRawColors('const style = { color: "#fff" };', component);
  const rgb = findRawColors('const style = { background: "rgba(1, 2, 3, 0.5)" };', component);
  const named = findRawColors('const style = { color: "rebeccapurple" };', component);
  const cssNamed = findRawColors(".sample { color: red; }", path.join(ROOT, "components", "sample.css"));
  const hwb = findRawColors('const style = { background: "hwb(120 0% 0%)" };', component);
  const tailwindPalette = findRawColors('const classes = "border-neutral-900 hover:from-indigo-500 data-[state=on]:bg-red-500 [&>svg]:fill-emerald-400";', component);
  const tailwindNamed = findRawColors('const classes = "text-[rebeccapurple]";', component);
  const tailwindInk = findRawColors('const classes = "bg-white";', component);
  const structural = findRawColors('const classes = "border-current bg-transparent shadow-[var(--shadow-card)]";', component);
  const token = findRawColors('const style = { color: "var(--status-danger)" };', component);
  const comment = findRawColors('// color: "#fff"; issue #211\nconst theme = "dark";', helper);
  const helperLiteral = findRawColors('export const ink = "#000000";', helper);
  const qr = findRawColors('const qr = { blackColor: "#000", whiteColor: "#fff" };', path.join(ROOT, "lib", "share.ts"));
  if (
    hex.length !== 1 || rgb.length !== 1 || named.length !== 1 || cssNamed.length !== 1 ||
    hwb.length !== 1 || tailwindPalette.length !== 1 || tailwindNamed.length !== 1 ||
    tailwindInk.length !== 1 || structural.length !== 0 || token.length !== 0 ||
    comment.length !== 0 || helperLiteral.length !== 1 || qr.length !== 0
  ) {
    throw new Error("raw-color gate self-test failed");
  }
  console.log("Raw-color gate self-test passed: literals and Tailwind palette utilities are rejected in UI helpers and CSS; comments, semantic tokens, structural colors, and scanner-safe QR inks are accepted.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const violations = SOURCE_ROOTS.flatMap(filesUnder).flatMap((file) =>
    findRawColors(readFileSync(file, "utf8"), file)
  );
  if (violations.length) {
    console.error(`Raw color literals found in themed UI:\n${violations.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log("Raw-color gate passed: themed UI uses semantic color tokens.");
  }
}
