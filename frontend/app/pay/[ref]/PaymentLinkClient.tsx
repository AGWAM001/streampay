"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet-context";
import WalletModal from "@/components/WalletModal";
import PaymentShareActions from "@/components/PaymentShareActions";
import { useToast } from "@/components/toast";
import { PaymentLinkResolution } from "@/app/actions";
import { verifyRecipientBinding } from "@/lib/payment-link";
import {
  claimStreamWithReceipt,
  ClaimReceipt,
  NETWORK_LABEL,
  describeError,
} from "@/lib/stellar";
import { computeAccruedAt } from "@/lib/accrual";

import { useLocale } from "@/lib/i18n/provider";
import { formatDateTime, formatPercent } from "@/lib/i18n/amounts";

function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-6)}`;
}

export default function PaymentLinkClient({
  refValue,
  initialResolution,
}: {
  refValue: string;
  initialResolution: PaymentLinkResolution;
}) {
  const { t, formatAmount, locale } = useLocale();
  const toast = useToast();

  const [resolution] = useState<PaymentLinkResolution | null>(
    initialResolution
  );
  const { address, signTransaction } = useWallet();
  const [modalOpen, setModalOpen] = useState(false);
  const [isRecipientMatch, setIsRecipientMatch] = useState<boolean | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ClaimReceipt | null>(null);
  const [nowSec, setNowSec] = useState<number>(() => Math.floor(Date.now() / 1000));

  // Ticker for live linear accrual counter
  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // When wallet address changes or resolution loads, check blinded recipient binding
  useEffect(() => {
    let active = true;
    async function checkBinding() {
      if (!address || !resolution?.decoded) {
        setIsRecipientMatch(null);
        return;
      }
      const match = await verifyRecipientBinding(resolution.decoded, address);
      if (active) {
        setIsRecipientMatch(match);
      }
    }
    checkBinding();
    return () => {
      active = false;
    };
  }, [address, resolution]);

  function connectWallet() {
    setClaimError(null);
    setModalOpen(true);
  }

  async function handleClaim() {
    if (!address) {
      connectWallet();
      return;
    }

    if (!resolution?.stream || !resolution.decoded) return;

    if (isRecipientMatch === false) {
      const message = t("pay.error.bindingMismatch");
      setClaimError(message);
      toast.error(message);
      return;
    }

    setClaiming(true);
    setClaimError(null);
    try {
      const resultReceipt = await claimStreamWithReceipt(
        address,
        resolution.decoded.streamId,
        signTransaction
      );
      setReceipt(resultReceipt);
      toast.success(t("pay.receipt.body"));
    } catch (err: unknown) {
      const message = describeError(err);
      setClaimError(message);
      toast.error(message);
    } finally {
      setClaiming(false);
    }
  }

  if (!resolution?.valid || !resolution.stream) {
    return (
      <main className="min-h-screen bg-[var(--surface-canvas)] text-[var(--foreground-default)] flex items-center justify-center p-4">
        <div className="bg-[var(--surface-raised)] border border-[var(--status-danger-border)] rounded-2xl p-8 max-w-md w-full text-center shadow-[var(--shadow-modal)]">
          <div className="w-12 h-12 bg-[var(--status-danger-subtle)] text-[var(--status-danger)] rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
            ✕
          </div>
          <h1 className="text-xl font-bold text-[var(--status-danger)] mb-2">{t("pay.invalid.title")}</h1>
          <p className="text-sm text-[var(--foreground-muted)] mb-6">
            {resolution?.error || t("pay.invalid.body")}
          </p>
          <Link
            href="/"
            className="inline-block px-5 py-2.5 bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--foreground-default)] rounded-xl text-sm font-medium transition"
          >
            {t("chrome.backToDashboard")}
          </Link>
        </div>
      </main>
    );
  }

  const stream = resolution.stream;
  const isCancelled = stream.status.toLowerCase() === "cancelled";
  const isDepleted = stream.status.toLowerCase() === "depleted";
  const hasEnded = nowSec >= stream.endTime;

  // Live real-time accrued calculation
  const totalDepositBig = BigInt(stream.deposit);
  const withdrawnBig = BigInt(stream.withdrawn);
  const accruedNowBig = computeAccruedAt(
    totalDepositBig,
    stream.startTime,
    stream.endTime,
    BigInt(nowSec)
  );
  const claimableNowBig = isCancelled || isDepleted
    ? 0n
    : (accruedNowBig > withdrawnBig ? accruedNowBig - withdrawnBig : 0n);

  const durationTotal = Math.max(1, stream.endTime - stream.startTime);
  const elapsedSec = Math.max(0, Math.min(nowSec - stream.startTime, durationTotal));
  const progressPercent = Math.min(100, Math.round((elapsedSec / durationTotal) * 100));

  // Receipt View
  if (receipt) {
    const explorerUrl = `https://stellar.expert/explorer/${NETWORK_LABEL}/tx/${receipt.txHash}`;
    return (
      <main className="min-h-screen bg-[var(--surface-canvas)] text-[var(--foreground-default)] flex items-center justify-center p-4">
        <div className="bg-[var(--surface-raised)] border border-[var(--status-success-border)] rounded-2xl p-8 max-w-lg w-full shadow-[var(--shadow-modal)] text-center">
          <div className="w-16 h-16 bg-[var(--status-success-subtle)] text-[var(--status-success)] rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">
            ✓
          </div>
          <h1 className="text-2xl font-bold text-[var(--status-success)] mb-2">{t("pay.receipt.title")}</h1>
          <p className="text-sm text-[var(--foreground-muted)] mb-6">{t("pay.receipt.body")}</p>

          <div className="bg-[var(--surface-inset)] border border-[var(--border-default)] rounded-xl p-5 mb-6 text-left space-y-3">
            <div className="flex justify-between items-center text-sm">
              <span className="text-[var(--foreground-muted)]">{t("pay.terminal.streamId")}</span>
              <span className="font-mono font-medium text-[var(--foreground-default)]">#{receipt.streamId}</span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-[var(--foreground-muted)]">{t("pay.receipt.claimedAmount")}</span>
              <span className="font-mono font-bold text-[var(--status-success)]">
                {formatAmount(receipt.amount)} {t("pay.invoice.unit.tokens")}
              </span>
            </div>
            <div className="flex justify-between items-center text-sm">
              <span className="text-[var(--foreground-muted)]">{t("pay.receipt.recipientWallet")}</span>
              <span className="font-mono text-[var(--foreground-default)]">{shortenAddress(address || "")}</span>
            </div>
            <div className="border-t border-[var(--border-default)] pt-3 flex flex-col gap-1 text-sm">
              <span className="text-[var(--foreground-muted)]">{t("pay.receipt.txHash")}</span>
              <span className="font-mono text-xs text-[var(--foreground-muted)] break-all">{receipt.txHash}</span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 px-4 py-3 bg-[var(--status-success-button)] hover:bg-[var(--status-success-button-end)] text-[var(--foreground-on-success)] rounded-xl text-sm font-semibold transition text-center shadow-[var(--shadow-card)]"
            >
              {t("pay.receipt.explorer")}
            </a>
            <Link
              href="/"
              className="px-4 py-3 bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--foreground-default)] rounded-xl text-sm font-medium transition text-center"
            >
              {t("chrome.dashboard")}
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // Dead state terminal cards
  if (isCancelled || isDepleted || (hasEnded && claimableNowBig === 0n)) {
    return (
      <main className="min-h-screen bg-[var(--surface-canvas)] text-[var(--foreground-default)] flex items-center justify-center p-4">
        <div className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-2xl p-8 max-w-md w-full text-center shadow-[var(--shadow-modal)]">
          <div className="w-12 h-12 bg-[var(--surface-inset)] text-[var(--foreground-muted)] rounded-full flex items-center justify-center mx-auto mb-4 text-2xl font-bold">
            !
          </div>
          <h1 className="text-xl font-bold mb-2">
            {isCancelled
              ? t("pay.terminal.cancelledTitle")
              : isDepleted
              ? t("pay.terminal.depletedTitle")
              : t("pay.terminal.completedTitle")}
          </h1>
          <p className="text-sm text-[var(--foreground-muted)] mb-6">
            {isCancelled
              ? t("pay.terminal.cancelledBody")
              : isDepleted
              ? t("pay.terminal.depletedBody")
              : t("pay.terminal.completedBody")}
          </p>

          <div className="bg-[var(--surface-canvas)] border border-[var(--border-default)] rounded-xl p-4 mb-6 text-left text-xs space-y-2 font-mono">
            <div className="flex justify-between">
              <span className="text-[var(--foreground-muted)]">{t("pay.terminal.streamId")}</span>
              <span className="text-[var(--foreground-default)]">#{stream.id}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--foreground-muted)]">{t("pay.terminal.totalFunded")}</span>
              <span className="text-[var(--foreground-default)]">{formatAmount(stream.deposit)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--foreground-muted)]">{t("pay.terminal.totalWithdrawn")}</span>
              <span className="text-[var(--foreground-default)]">{formatAmount(stream.withdrawn)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--foreground-muted)]">{t("pay.terminal.status")}</span>
              <span className="capitalize text-[var(--status-warning)]">{stream.status}</span>
            </div>
          </div>

          <Link
            href="/"
            className="inline-block px-5 py-2.5 bg-[var(--surface-inset)] hover:bg-[var(--surface-hover)] text-[var(--foreground-default)] rounded-xl text-sm font-medium transition"
          >
            {t("chrome.goToAppHome")}
          </Link>
        </div>
      </main>
    );
  }

  // Active Stream Claim Surface
  return (
    <main className="min-h-screen bg-[var(--surface-canvas)] text-[var(--foreground-default)] flex flex-col justify-between p-4 sm:p-8">
      <header className="max-w-2xl mx-auto w-full flex justify-between items-center py-4 border-b border-[var(--border-default)] mb-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-[var(--accent-strong)] to-[var(--accent-secondary-strong)] flex items-center justify-center font-bold text-[var(--foreground-on-accent)] shadow-[var(--shadow-card)]">
            S
          </div>
          <span className="font-bold tracking-tight text-lg text-[var(--foreground-default)]">{t("brand.name")}</span>
        </Link>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-full bg-[var(--status-success-subtle)] text-[var(--status-success)] border border-[var(--status-success-border)] font-medium">
            {t("chrome.networkLive", { network: NETWORK_LABEL })}
          </span>
        </div>
      </header>

      <div className="max-w-xl mx-auto w-full my-auto">
        <div className="bg-[var(--surface-raised)] border border-[var(--border-default)] rounded-3xl p-6 sm:p-8 shadow-[var(--shadow-modal)] relative overflow-hidden backdrop-blur-xl">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[var(--accent-subtle-soft)] rounded-full blur-3xl pointer-events-none" />

          {/* Header */}
          <div className="flex justify-between items-start mb-6">
            <div>
              <span className="text-xs uppercase tracking-wider font-semibold text-[var(--accent-primary)]">
                {t("pay.invoice.kicker")}
              </span>
              <h1 className="text-2xl sm:text-3xl font-extrabold text-[var(--foreground-default)] mt-1">
                {t("pay.invoice.title", { id: stream.id })}
              </h1>
            </div>
            <span className="px-3 py-1 rounded-full text-xs font-semibold bg-[var(--status-success-subtle)] text-[var(--status-success)] border border-[var(--status-success-border)]">
              {t("pay.invoice.active")}
            </span>
          </div>

          {/* Accrued / Available Box */}
          <div className="bg-gradient-to-br from-[var(--accent-subtle)] via-[var(--surface-raised)] to-[var(--surface-canvas)] border border-[var(--accent-border)] rounded-2xl p-6 mb-6 text-center shadow-[var(--shadow-card)]">
            <span className="text-xs font-medium text-[var(--accent-primary)] uppercase tracking-wide">
              {t("pay.invoice.availableLabel")}
            </span>
            <div className="text-3xl sm:text-4xl font-extrabold text-[var(--foreground-default)] font-mono my-2 tracking-tight">
              {formatAmount(claimableNowBig)}{" "}
              <span className="text-sm font-sans font-medium text-[var(--foreground-muted)]">{t("pay.invoice.unit.tokens")}</span>
            </div>
            <div className="text-xs text-[var(--foreground-muted)] flex items-center justify-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-[var(--status-success)] animate-pulse" />
              {t("pay.invoice.streaming")}
            </div>
          </div>

          {/* Progress Bar */}
          <div className="mb-6">
            <div className="flex justify-between text-xs text-[var(--foreground-muted)] mb-2">
              <span>{t("pay.invoice.progress", { percent: formatPercent(progressPercent, locale) })}</span>
              <span>
                {t("pay.invoice.total", { amount: formatAmount(stream.deposit), unit: "tokens" })}
              </span>
            </div>
            <div className="w-full bg-[var(--surface-inset)] h-2.5 rounded-full overflow-hidden">
              <div
                className="bg-gradient-to-r from-[var(--accent-primary)] to-[var(--accent-secondary)] h-full transition-all duration-1000 ease-linear rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          {/* Details Table */}
          <div className="bg-[var(--surface-inset)] border border-[var(--border-default)] rounded-2xl p-4 sm:p-5 mb-6 space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-[var(--foreground-muted)] text-xs sm:text-sm">{t("pay.invoice.payer")}</span>
              <span className="font-mono text-xs sm:text-sm text-[var(--foreground-default)]">
                {shortenAddress(stream.sender)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[var(--foreground-muted)] text-xs sm:text-sm">{t("pay.invoice.payee")}</span>
              <span className="inline-flex items-center gap-1.5 text-xs text-[var(--accent-primary)] bg-[var(--accent-subtle)] px-2.5 py-1 rounded-lg border border-[var(--accent-border)]">
                {t("pay.invoice.payeeProtected")}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[var(--foreground-muted)] text-xs sm:text-sm">{t("pay.invoice.token")}</span>
              <span className="font-mono text-xs text-[var(--foreground-muted)]">
                {shortenAddress(stream.token)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[var(--foreground-muted)] text-xs sm:text-sm">{t("pay.invoice.alreadyClaimed")}</span>
              <span className="font-mono text-xs sm:text-sm text-[var(--foreground-default)]">
                {formatAmount(stream.withdrawn)} {t("pay.invoice.unit.tokens")}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[var(--foreground-muted)] text-xs sm:text-sm">{t("pay.invoice.endTime")}</span>
              <span className="text-xs text-[var(--foreground-muted)]">
                {formatDateTime(stream.endTime, locale)}
              </span>
            </div>
          </div>

          {/* Wallet and Verification Status */}
          {address && (
            <div className="mb-6 p-4 rounded-xl border border-[var(--border-default)] text-xs flex items-center justify-between gap-3 bg-[var(--surface-inset)]">
              <div>
                <span className="text-[var(--foreground-muted)] block mb-0.5">{t("pay.wallet.connected")}</span>
                <span className="font-mono text-[var(--foreground-default)] font-medium">{shortenAddress(address)}</span>
              </div>
              {isRecipientMatch === true && (
                <span className="px-2.5 py-1 rounded-full bg-[var(--status-success-subtle)] text-[var(--status-success)] border border-[var(--status-success-border)] font-semibold flex items-center gap-1">
                  {t("pay.wallet.verified")}
                </span>
              )}
              {isRecipientMatch === false && (
                <span className="px-2.5 py-1 rounded-full bg-[var(--status-danger-subtle)] text-[var(--status-danger)] border border-[var(--status-danger-border)] font-semibold flex items-center gap-1">
                  {t("pay.wallet.mismatch")}
                </span>
              )}
            </div>
          )}

          {/* Error Alert */}
          {claimError && (
            <div
              role="alert"
              className="p-4 mb-6 rounded-xl bg-[var(--status-danger-subtle)] border border-[var(--status-danger-border)] text-[var(--status-danger)] text-xs space-y-1"
            >
              <div className="font-semibold flex items-center gap-1.5">
                <span>⚠️</span> {t("pay.error.heading")}
              </div>
              <p>{claimError}</p>
            </div>
          )}

          {/* Action Button */}
          {!address ? (
            <button
              type="button"
              id="connect-claim-button"
              onClick={connectWallet}
              className="w-full py-4 px-6 rounded-2xl font-bold text-[var(--foreground-on-accent)] bg-gradient-to-r from-[var(--accent-strong)] via-[var(--accent-strong)] to-[var(--accent-secondary-strong)] hover:from-[var(--accent-strong-hover)] hover:to-[var(--accent-secondary-strong-hover)] transition shadow-[var(--shadow-card)] flex items-center justify-center gap-2 text-base"
            >
              {t("pay.action.connectAndClaim")}
            </button>
          ) : (
            <button
              type="button"
              id="claim-now-button"
              disabled={claiming || isRecipientMatch === false || claimableNowBig === 0n}
              onClick={handleClaim}
              className={`w-full py-4 px-6 rounded-2xl font-bold transition shadow-[var(--shadow-card)] flex items-center justify-center gap-2 text-base ${
                isRecipientMatch === false || claimableNowBig === 0n
                  ? "bg-[var(--surface-inset)] text-[var(--foreground-muted)] cursor-not-allowed shadow-none"
                  : claiming
                  ? "bg-[var(--accent-strong-hover)] text-[var(--foreground-on-accent)] cursor-wait"
                  : "bg-gradient-to-r from-[var(--status-success-button)] to-[var(--status-success-button-end)] hover:from-[var(--status-success-button-end)] hover:to-[var(--status-success-button)] text-[var(--foreground-on-success)]"
              }`}
            >
              {claiming ? (
                <>
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  {t("pay.action.claiming")}
                </>
              ) : isRecipientMatch === false ? (
                t("pay.action.switchAccount")
              ) : claimableNowBig === 0n ? (
                t("pay.action.nothingToClaim")
              ) : (
                t("pay.action.claim", { amount: formatAmount(claimableNowBig) })
              )}
            </button>
          )}

          <p className="text-center text-[var(--foreground-muted)] text-xs mt-4">
            {t("pay.note")}
          </p>
        </div>
      </div>

      <div className="max-w-xl mx-auto w-full mt-6">
        <PaymentShareActions refValue={refValue} />
      </div>

      <footer className="max-w-2xl mx-auto w-full text-center py-6 text-xs text-[var(--foreground-muted)] border-t border-[var(--border-default)] mt-8">
        {t("brand.footer")}
      </footer>

      <WalletModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </main>
  );
}
