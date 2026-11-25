import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { ToastProvider } from "@/components/toast";
import { WalletProvider } from "@/lib/wallet-context";
import NetworkBadge from "@/components/NetworkBadge";
import LocaleSwitcher from "@/components/LocaleSwitcher";
import { LocaleProvider } from "@/lib/i18n/provider";
import { resolveRequestLocale } from "@/lib/i18n/server";
import { localeDir } from "@/lib/i18n/locales";
import { formatMessage } from "@/lib/i18n/format";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await resolveRequestLocale();
  return {
    title: `${formatMessage(locale, "brand.name")} — ${formatMessage(locale, "brand.tagline")}`,
    description: formatMessage(locale, "home.tagline"),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const locale = await resolveRequestLocale();

  return (
    // `lang` and `dir` are set on the first server render, not patched in
    // afterwards: the document language drives screen-reader pronunciation and
    // is read before any script runs.
    <html lang={locale} dir={localeDir(locale)} suppressHydrationWarning>
      <head>
        {/* Blocking: resolve persisted/system theme before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <ThemeProvider>
          <WalletProvider>
            {/* Skip navigation — WCAG 2.4.1 Bypass Blocks */}
            <a href="#main-content" className="skip-link">
              {formatMessage(locale, "chrome.skipToContent")}
            </a>
            <ToastProvider>
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 12px" }}>
                <LocaleSwitcher />
              </div>
              <NetworkBadge />
              <div id="main-content">{children}</div>
            </ToastProvider>
          </WalletProvider>
          </ThemeProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
