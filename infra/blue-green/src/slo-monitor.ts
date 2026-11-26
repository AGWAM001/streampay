/**
 * Post-cutover SLO evaluator for blue-green indexer deploys (#614).
 *
 * Evaluates:
 * - Ingestion lag (#483)
 * - Outbox lag (#542)
 * - Error rate
 * - RPC failover health
 */

export interface SloThresholds {
  maxIngestionLagSec: number;
  maxOutboxLagItems: number;
  maxErrorRate: number;
  maxRpcErrorRate: number;
  sustainedBreachSamples: number;
}

export interface SloSample {
  timestampMs: number;
  ingestionLagSec: number;
  outboxLagItems: number;
  errorRate: number;
  rpcHealthy: boolean;
  rpcErrorRate: number;
}

export interface SloEvaluationResult {
  healthy: boolean;
  shouldRollback: boolean;
  breachedMetrics: string[];
  consecutiveBreaches: number;
}

export const DEFAULT_SLO_THRESHOLDS: SloThresholds = {
  maxIngestionLagSec: 30,
  maxOutboxLagItems: 500,
  maxErrorRate: 0.05,
  maxRpcErrorRate: 0.2,
  sustainedBreachSamples: 2,
};

export function evaluateSloSample(
  sample: SloSample,
  thresholds: SloThresholds = DEFAULT_SLO_THRESHOLDS
): string[] {
  const breaches: string[] = [];

  if (sample.ingestionLagSec > thresholds.maxIngestionLagSec) {
    breaches.push(
      `ingestion_lag_sec=${sample.ingestionLagSec} > ${thresholds.maxIngestionLagSec} (#483)`
    );
  }
  if (sample.outboxLagItems > thresholds.maxOutboxLagItems) {
    breaches.push(
      `outbox_lag_items=${sample.outboxLagItems} > ${thresholds.maxOutboxLagItems} (#542)`
    );
  }
  if (sample.errorRate > thresholds.maxErrorRate) {
    breaches.push(`error_rate=${sample.errorRate} > ${thresholds.maxErrorRate}`);
  }
  if (!sample.rpcHealthy || sample.rpcErrorRate > thresholds.maxRpcErrorRate) {
    breaches.push(
      `rpc_failover_unhealthy (healthy=${sample.rpcHealthy}, rpc_error_rate=${sample.rpcErrorRate} > ${thresholds.maxRpcErrorRate})`
    );
  }

  return breaches;
}

export function evaluateSloWindow(
  samples: SloSample[],
  thresholds: SloThresholds = DEFAULT_SLO_THRESHOLDS
): SloEvaluationResult {
  let consecutiveBreaches = 0;
  let lastBreaches: string[] = [];

  for (const sample of samples) {
    const breaches = evaluateSloSample(sample, thresholds);
    if (breaches.length > 0) {
      consecutiveBreaches += 1;
      lastBreaches = breaches;
    } else {
      consecutiveBreaches = 0;
      lastBreaches = [];
    }
  }

  return {
    healthy: lastBreaches.length === 0,
    shouldRollback: consecutiveBreaches >= thresholds.sustainedBreachSamples,
    breachedMetrics: lastBreaches,
    consecutiveBreaches,
  };
}
