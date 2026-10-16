import type { InternalListingRecord, ConsentLifecycleState } from "./types.ts";

/**
 * Interface for private consent proof storage.
 * Completely segregated from public index queries.
 */
export interface PrivateConsentProof {
  listingId: string;
  streamId: string;
  depositRaw: string;
  sender: string;
  recipient: string;
  senderConsent: {
    address: string;
    signature: string;
    shareAddress: boolean;
  };
  recipientConsent: {
    address: string;
    signature: string;
    shareAddress: boolean;
  };
  nonce: string;
  expiry: number;
}

/**
 * In-Memory Directory Store with Strict Physical Separation
 * between Public Index Entries and Private Consent Proofs.
 */
class DiscoveryStore {
  // Public index table: contains only aggregated metadata and lifecycle state
  private publicRecords = new Map<string, InternalListingRecord>();

  // Private proof vault: contains on-chain stream IDs, raw stroop amounts, and cryptographic signatures
  private privateProofVault = new Map<string, PrivateConsentProof>();

  // Replay prevention: set of used nonces
  private usedNonces = new Set<string>();

  // Optional proposals waiting for second signature
  private pendingProposals = new Map<string, {
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  }>();

  public saveListing(record: InternalListingRecord): void {
    // 1. Store private proof in secure vault
    const proof: PrivateConsentProof = {
      listingId: record.listingId,
      streamId: record.streamId,
      depositRaw: record.depositRaw,
      sender: record.sender,
      recipient: record.recipient,
      senderConsent: record.senderConsent,
      recipientConsent: record.recipientConsent,
      nonce: record.nonce,
      expiry: record.expiry,
    };
    this.privateProofVault.set(record.listingId, proof);

    // 2. Mark nonce as consumed
    this.usedNonces.add(record.nonce);

    // 3. Store active public record
    this.publicRecords.set(record.listingId, { ...record });
  }

  public getListing(listingId: string): InternalListingRecord | undefined {
    return this.publicRecords.get(listingId);
  }

  public getProof(listingId: string): PrivateConsentProof | undefined {
    return this.privateProofVault.get(listingId);
  }

  public getActiveListings(): InternalListingRecord[] {
    return Array.from(this.publicRecords.values()).filter(
      (r) => r.state === "PUBLISHED"
    );
  }

  public markWithdrawn(listingId: string, timestamp: number): boolean {
    const record = this.publicRecords.get(listingId);
    if (!record) return false;

    record.state = "WITHDRAWN" as ConsentLifecycleState;
    record.withdrawnAt = timestamp;
    this.publicRecords.set(listingId, record);
    return true;
  }

  public hasNonce(nonce: string): boolean {
    return this.usedNonces.has(nonce);
  }

  public addNonce(nonce: string): void {
    this.usedNonces.add(nonce);
  }

  public saveProposal(proposalId: string, proposal: {
    streamId: string;
    nonce: string;
    expiry: number;
    initiatorConsent: {
      address: string;
      signature: string;
      shareAddress: boolean;
    };
  }): void {
    this.pendingProposals.set(proposalId, proposal);
  }

  public getProposal(proposalId: string) {
    return this.pendingProposals.get(proposalId);
  }

  public clear(): void {
    this.publicRecords.clear();
    this.privateProofVault.clear();
    this.usedNonces.clear();
    this.pendingProposals.clear();
  }
}

// Global singleton to preserve directory state across Next.js API requests
const globalStore = globalThis as unknown as {
  __streampay_discovery_store__?: DiscoveryStore;
};

if (!globalStore.__streampay_discovery_store__) {
  globalStore.__streampay_discovery_store__ = new DiscoveryStore();
}

export const discoveryStore = globalStore.__streampay_discovery_store__;
