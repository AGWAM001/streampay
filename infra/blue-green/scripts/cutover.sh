#!/usr/bin/env bash
# Atomic blue-green indexer cutover script (#614).
# Usage: infra/blue-green/scripts/cutover.sh <target-slot: blue|green> <version> [--mock]
set -euo pipefail

target_slot="${1:?usage: cutover.sh <blue|green> <version> [--mock]}"
version="${2:?usage: cutover.sh <blue|green> <version> [--mock]}"
mode="${3:-}"

if [[ "$target_slot" != "blue" && "$target_slot" != "green" ]]; then
  echo "error: target slot must be 'blue' or 'green' (got '$target_slot')" >&2
  exit 1
fi

audit_log="${BLUE_GREEN_AUDIT_LOG:-deployments/blue-green-audit.log}"
mkdir -p "$(dirname "$audit_log")"

ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "$mode" == "--mock" ]]; then
  echo "[mock] staging $version on slot=$target_slot"
  echo "[mock] advancing leader fence epoch and switching router -> $target_slot"
  echo "$ts action=cutover slot=$target_slot version=$version mode=mock" >> "$audit_log"
  exit 0
fi

if [[ "${MANUAL_OVERRIDE:-false}" == "true" ]]; then
  echo "error: MANUAL_OVERRIDE=true prevents automated cutover" >&2
  exit 2
fi

kubectl -n "${K8S_NAMESPACE:-streampay}" set image "deployment/streampay-indexer-${target_slot}" "indexer=${version}"
kubectl -n "${K8S_NAMESPACE:-streampay}" rollout status "deployment/streampay-indexer-${target_slot}" --timeout=120s
kubectl -n "${K8S_NAMESPACE:-streampay}" patch service streampay-indexer-router \
  -p "{\"spec\":{\"selector\":{\"app.kubernetes.io/slot\":\"${target_slot}\"}}}"

echo "$ts action=cutover slot=$target_slot version=$version mode=live" >> "$audit_log"
echo "Cutover complete: router now points to slot=$target_slot ($version)"

