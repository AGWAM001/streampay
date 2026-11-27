# Blue-Green Indexer Stack Configuration (#614).
#
# Provisions parallel `blue` and `green` indexer definitions sharing the
# projection store pattern, plus an atomic router descriptor and SLO-triggered
# rollback policy.

variable "blue_green_enabled" {
  description = "Enable parallel blue/green indexer stacks with atomic router cutover."
  type        = bool
  default     = false
}

variable "blue_green_active_slot" {
  description = "Currently active indexer slot receiving live router traffic."
  type        = string
  default     = "blue"

  validation {
    condition     = contains(["blue", "green"], var.blue_green_active_slot)
    error_message = "blue_green_active_slot must be either 'blue' or 'green'."
  }
}

variable "blue_green_slo_policy" {
  description = "Post-cutover SLO thresholds and bounded rollback timing."
  type = object({
    max_ingestion_lag_sec    = optional(number, 30)
    max_outbox_lag_items     = optional(number, 500)
    max_error_rate           = optional(number, 0.05)
    max_rpc_error_rate       = optional(number, 0.20)
    sustained_breach_samples = optional(number, 2)
    max_time_to_revert_sec   = optional(number, 15)
  })
  default = {}
}

locals {
  blue_green_slots = var.blue_green_enabled ? {
    for slot in ["blue", "green"] : slot => {
      name         = "${var.namespace_prefix}-indexer-${slot}"
      slot         = slot
      active       = slot == var.blue_green_active_slot
      image        = var.images.indexer
      health_path  = "/health"
      metrics_path = "/metrics"
      env = merge(local.indexer_env, {
        BLUE_GREEN_SLOT         = slot
        BLUE_GREEN_ACTIVE_SLOT  = var.blue_green_active_slot
        PROJECTION_STORE_SHARED = "true"
        OUTBOX_FENCE_ENABLED    = "true"
      })
    }
  } : {}

  blue_green_router = var.blue_green_enabled ? {
    service_name        = "${var.namespace_prefix}-indexer-router"
    active_slot         = var.blue_green_active_slot
    target_service      = "${var.namespace_prefix}-indexer-${var.blue_green_active_slot}"
    port                = var.runtime.indexer_port
    slo_rollback_policy = var.blue_green_slo_policy
  } : null
}

output "blue_green_topology" {
  description = "Parallel blue/green indexer stacks, atomic router target, and SLO rollback policy."
  value = {
    enabled = var.blue_green_enabled
    slots   = local.blue_green_slots
    router  = local.blue_green_router
  }
}
