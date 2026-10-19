#!/usr/bin/env bash
# check_error_codes.sh — guard the StreamError numeric contract.
#
# Every StreamError variant carries a numeric code that is part of the public,
# on-chain interface: clients branch on it, so a code is never renumbered,
# reused, or removed — new variants are appended with the next free code, and a
# variant that becomes unreachable is *retired* (kept in the enum) rather than
# deleted. Two accidents this catches in milliseconds, instead of the minutes of
# cargo it takes to surface the same thing as `E0081: discriminant value
# assigned to multiple variants` (or, worse, as a silent wire-protocol break):
#
#   1. a duplicated numeric code — the classic case is two contributor PRs that
#      each append "the next free code" against the same main and collide after
#      one of them merges. CI runs this on the PR *merge* ref, so both sides of
#      the collision are already in the same file;
#   2. a missing code (a gap in 1..max) — the signature of a variant that was
#      deleted or renumbered, which silently invalidates existing clients.
#
# Exit 0 = codes unique and gapless; 1 = duplicate/invalid (blocking); gaps are
# reported as warnings because a defensive skip is ugly, not breaking.
#
# Usage: bash scripts/check_error_codes.sh   (from anywhere; paths are repo-rooted)
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2
ENUM="contracts/streaming-payments/src/errors.rs"

if [ ! -f "$ENUM" ]; then
  echo "::error::${ENUM} not found — the error-code gate cannot run."
  exit 1
fi

# Emit "<line> <VariantName> <code>" for each `Name = 12,` inside the enum body
# (comments stripped, so doc comments can never be mistaken for variants).
body="$(awk '
  /^pub enum StreamError[ \t]*\{/ {inen=1; next}
  inen && /^\}/                  {inen=0}
  inen {
    line=$0
    sub(/\/\/.*/, "", line)
    if (match(line, /^[ \t]*[A-Za-z_][A-Za-z0-9_]*[ \t]*=[ \t]*[0-9]+[ \t]*,?$/)) {
      n=line; gsub(/[ \t,]/, "", n)
      split(n, a, "=")
      print NR" "a[1]" "a[2]
    }
  }
' "$ENUM")"

if [ -z "$body" ]; then
  echo "::error::no discriminants parsed from ${ENUM} — the enum shape changed. Update this gate to match; do not drop it."
  exit 1
fi

count="$(printf '%s\n' "$body" | wc -l | tr -d ' ')"
min="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | head -1)"
max="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | tail -1)"
next_free=$((max + 1))

errors=0
has_gaps=0
warn() { echo "::warning file=${ENUM}::$1"; }
fail() { echo "::error file=${ENUM},line=$1::$2"; errors=$((errors + 1)); }

# 1. duplicated numeric codes (blocking)
for code in $(printf '%s\n' "$body" | awk '{print $3}' | sort -n | uniq -d); do
  first_line="$(printf '%s\n' "$body" | awk -v c="$code" '$3 == c {print $1; exit}')"
  owners="$(printf '%s\n' "$body" | awk -v c="$code" '$3 == c {printf "%s (line %s), ", $2, $1}' | sed 's/, $//')"
  fail "$first_line" "Duplicate StreamError code ${code}: ${owners}. Codes are the wire contract — keep the variant that already owns ${code} and move the other to ${next_free} or higher, then regenerate the artifacts ('npm run generated:check')."
done

# 2. duplicated variant names (blocking; Rust would not compile, but the
#    message beats an E0255 in a 4-minute build log)
for name in $(printf '%s\n' "$body" | awk '{print $2}' | sort | uniq -d); do
  first_line="$(printf '%s\n' "$body" | awk -v n="$name" '$2 == n {print $1; exit}')"
  fail "$first_line" "Duplicate StreamError variant name '${name}'."
done

# 3. code 0 is not a valid Soroban error code (blocking)
while read -r line name code; do
  [ "${code:-}" = "0" ] && fail "$line" "StreamError::${name} = 0 — Soroban contract error codes start at 1."
done <<< "$(printf '%s\n' "$body" | awk '$3 == 0')"

# 4. gaps in 1..max (warning): every retired variant stays, so the set must be
#    contiguous. A gap means a code was deleted or skipped.
gaps="$(printf '%s\n' "$body" | awk '{print $3}' | sort -n | awk '
  NR > 1 && $1 != prev + 1 { if ($1 > prev + 1) printf "%s..%s ", prev + 1, $1 - 1 }
  { prev = $1 }')"
if [ -n "$(printf '%s' "$gaps" | tr -d ' ')" ]; then
  has_gaps=1
  warn "Codes in use run ${min}–${max} but ${count} variants leave gaps (${gaps}). A code is never reused or deleted: an unreachable variant is retired in place. If nothing was removed, renumber your new variant into the gap and use ${next_free} for the rest."
fi

if [ "$errors" -gt 0 ]; then
  echo
  echo "Found ${errors} problem(s) in ${ENUM} (${count} variants, codes ${min}–${max})."
  echo "New variants take code ${next_free} (the highest code in use plus one) at the bottom of the enum."
  echo "After fixing, regenerate everything that reads this enum:"
  echo "    npm run generated:check   # error-surface table, catalog, frontend/lib/errors.ts"
  exit 1
fi

if [ "$has_gaps" = "1" ]; then
  echo "StreamError: ${count} variants, codes ${min}–${max}, unique but not contiguous (see the gap warning above). Next free code: ${next_free}."
else
  echo "StreamError: ${count} variants, codes ${min}–${max}, unique and contiguous. Next free code: ${next_free}."
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Error-code registry"
    echo ""
    echo "| Variants | Codes in use | Next free code |"
    echo "| --- | --- | --- |"
    echo "| ${count} | ${min}–${max} | ${next_free} |"
  } >> "$GITHUB_STEP_SUMMARY"
fi
