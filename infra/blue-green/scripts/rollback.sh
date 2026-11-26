#!/usr/bin/env bash
# Bounded blue-green indexer rollback script (#614).
# Usage: infra/blue-green/scripts/rollback.sh <restore-slot: blue|green> <reason> [--mock]
set -euo pipefail

restore_slot="${1:?usage: rollback.sh <blue|green> <reason> [--mock]}"
reason="${2:?usage: rollback.sh <blue|green> <reason> [--mock]}"
mode="${3:-}"

if [[ "$restore_slot" != "blue" && "$restore_slot" != "green" ]]; then
  echo "error: restore slot must be 'blue' or 'green' (got '$restore_slot')" >&2
  exit 1
fi

audit_log="${BLUE_GREEN_AUDIT_LOG:-deployments/blue-green-audit.log}"
mkdir -p "$(dirname "$audit_log")"

ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "$mode" == "--mock" ]]; then
  echo "[mock] fencing old leader and reverting router -> $restore_slot ($reason)"
  echo "$ts action=rollback slot=$restore_slot reason=\"$reason\" mode=mock" >> "$audit_log"
  exit 0
fi

kubectl -n "${K8S_NAMESPACE:-streampay}" patch service streampay-indexer-router \
  -p "{\"spec\":{\"selector\":{\"app.kubernetes.io/slot\":\"${restore_slot}\"}}}"

echo "$ts action=rollback slot=$restore_slot reason=\"$reason\" mode=live" >> "$audit_log"
echo "Rollback complete: router reverted to slot=$restore_slot ($reason)"

