"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  StreamPayClient,
  WalletRegistry,
  type SelectedWallet,
  type StreamPayClientOptions,
  type WalletAccount,
  type WalletStandardAdapter,
} from "@streampay/sdk";
import { StreamPayStore } from "./store.js";

export type ReactWalletAdapter = WalletStandardAdapter;

export interface StreamPayProviderProps {
  children: ReactNode;
  client?: StreamPayClient;
  clientOptions?: StreamPayClientOptions;
  wallet?: ReactWalletAdapter;
  eventFeedUrl?: string;
}

export interface WalletState {
  account: WalletAccount | undefined;
  wallets: readonly SelectedWallet[];
  connected: boolean;
  connecting: boolean;
  error: Error | undefined;
  connect(walletId?: string): Promise<WalletAccount>;
  disconnect(): Promise<void>;
  refreshWallets(): Promise<void>;
}

export interface StreamPayContextValue {
  client: StreamPayClient;
  store: StreamPayStore;
  wallet: WalletState;
}

const StreamPayContext = createContext<StreamPayContextValue | undefined>(undefined);

export function StreamPayProvider({
  children,
  client,
  clientOptions,
  wallet,
  eventFeedUrl,
}: StreamPayProviderProps) {
  if (client === undefined && clientOptions === undefined) {
    throw new Error("StreamPayProvider requires client or clientOptions");
  }
  const optionsRef = useRef(clientOptions);
  optionsRef.current = clientOptions;
  const [currentClient, setCurrentClient] = useState(
    () => client ?? new StreamPayClient(clientOptions!)
  );
  const [account, setAccount] = useState<WalletAccount>();
  const [wallets, setWallets] = useState<readonly SelectedWallet[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [walletError, setWalletError] = useState<Error>();
  const selectedRef = useRef<SelectedWallet | undefined>(undefined);
  const registry = useMemo(() => wallet === undefined ? undefined : new WalletRegistry([wallet]), [wallet]);
  const networkPassphrase = currentClient.networkPassphrase ||
    optionsRef.current?.networkPassphrase || "Test SDF Network ; September 2015";
  const store = useMemo(
    () => new StreamPayStore(currentClient, eventFeedUrl),
    [currentClient, eventFeedUrl]
  );

  const refreshWallets = useCallback(async () => {
    if (!registry) {
      setWallets([]);
      return;
    }
    try {
      setWallets(await registry.discover({ networkPassphrase }));
      setWalletError(undefined);
    } catch (error) {
      setWalletError(asError(error));
    }
  }, [networkPassphrase, registry]);

  useEffect(() => {
    void refreshWallets();
  }, [refreshWallets]);

  const connectWallet = useCallback(async (walletId?: string): Promise<WalletAccount> => {
    if (!registry) throw new Error("No wallet adapter was supplied");
    if (!optionsRef.current) {
      throw new Error("clientOptions are required to attach a wallet signer");
    }
    setConnecting(true);
    setWalletError(undefined);
    try {
      const connected = await registry.connectSigner({ networkPassphrase }, walletId);
      selectedRef.current = connected.selected;
      setCurrentClient(new StreamPayClient({ ...optionsRef.current, signer: connected.signer }));
      setAccount(connected.account);
      return connected.account;
    } catch (error) {
      setWalletError(asError(error));
      throw error;
    } finally {
      setConnecting(false);
    }
  }, [networkPassphrase, registry]);

  const disconnectWallet = useCallback(async (): Promise<void> => {
    await selectedRef.current?.adapter.disconnect();
    selectedRef.current = undefined;
    setAccount(undefined);
    if (optionsRef.current) {
      const { signer: _signer, ...withoutSigner } = optionsRef.current;
      setCurrentClient(new StreamPayClient(withoutSigner));
    }
  }, []);

  const value = useMemo<StreamPayContextValue>(() => ({
    client: currentClient,
    store,
    wallet: {
      account,
      wallets,
      connected: account !== undefined,
      connecting,
      error: walletError,
      connect: connectWallet,
      disconnect: disconnectWallet,
      refreshWallets,
    },
  }), [
    account,
    connectWallet,
    connecting,
    currentClient,
    disconnectWallet,
    refreshWallets,
    store,
    walletError,
    wallets,
  ]);

  return <StreamPayContext.Provider value={value}>{children}</StreamPayContext.Provider>;
}

export function useStreamPay(): StreamPayContextValue {
  const value = useContext(StreamPayContext);
  if (!value) throw new Error("useStreamPay must be used inside StreamPayProvider");
  return value;
}

export function useWallet(): WalletState {
  return useStreamPay().wallet;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
