/**
 * Leader fencing & exactly-once projection/outbox guard (#212) for blue-green
 * indexer cutover and automatic rollback (#614).
 */

export type DeploymentSlot = "blue" | "green";

export class StaleEpochError extends Error {
  public readonly expectedEpoch: number;
  public readonly receivedEpoch: number;
  public readonly slot: DeploymentSlot;

  constructor(slot: DeploymentSlot, receivedEpoch: number, expectedEpoch: number) {
    super(
      `StaleEpochError: slot "${slot}" attempted write/delivery with epoch ${receivedEpoch}, but active fence epoch is ${expectedEpoch}`
    );
    this.name = "StaleEpochError";
    this.slot = slot;
    this.receivedEpoch = receivedEpoch;
    this.expectedEpoch = expectedEpoch;
  }
}

export interface ProjectionEvent {
  eventId: string;
  ledger: number;
  payload: unknown;
}

export interface OutboxDelivery {
  eventId: string;
  deliveredBy: DeploymentSlot;
  epoch: number;
  deliveredAtMs: number;
}

/**
 * Shared projection + outbox store with monotonic leader fencing.
 * Guarantees exactly-once projection commits and webhook outbox deliveries
 * across blue-green cutovers and rollbacks.
 */
export class FencedProjectionOutboxStore {
  private activeSlot: DeploymentSlot;
  private fenceEpoch: number;
  private committedEvents = new Set<string>();
  private deliveredOutbox = new Map<string, OutboxDelivery>();

  constructor(initialSlot: DeploymentSlot = "blue", initialEpoch: number = 1) {
    this.activeSlot = initialSlot;
    this.fenceEpoch = initialEpoch;
  }

  public getFenceState(): { activeSlot: DeploymentSlot; fenceEpoch: number } {
    return { activeSlot: this.activeSlot, fenceEpoch: this.fenceEpoch };
  }

  /**
   * Atomically advances the monotonic fence epoch and transfers leadership to `nextSlot`.
   * Any in-flight worker from the previous slot holding an older epoch is fenced out.
   */
  public transferLeadership(nextSlot: DeploymentSlot): number {
    this.fenceEpoch += 1;
    this.activeSlot = nextSlot;
    return this.fenceEpoch;
  }

  public assertFenced(slot: DeploymentSlot, epoch: number): void {
    if (epoch !== this.fenceEpoch || slot !== this.activeSlot) {
      throw new StaleEpochError(slot, epoch, this.fenceEpoch);
    }
  }

  /**
   * Commits a projected event + outbox delivery exactly once if the caller holds
   * the current active fence epoch. Duplicate event IDs are idempotently ignored.
   */
  public commitAndDeliver(
    slot: DeploymentSlot,
    epoch: number,
    event: ProjectionEvent,
    nowMs: number = Date.now()
  ): { committed: boolean; duplicate: boolean } {
    this.assertFenced(slot, epoch);

    if (this.committedEvents.has(event.eventId)) {
      return { committed: false, duplicate: true };
    }

    this.committedEvents.add(event.eventId);
    this.deliveredOutbox.set(event.eventId, {
      eventId: event.eventId,
      deliveredBy: slot,
      epoch,
      deliveredAtMs: nowMs,
    });

    return { committed: true, duplicate: false };
  }

  public getCommittedEventIds(): string[] {
    return Array.from(this.committedEvents);
  }

  public getOutboxDeliveries(): OutboxDelivery[] {
    return Array.from(this.deliveredOutbox.values());
  }
}

