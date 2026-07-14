"use client";

import { ChevronDown, Copy, ExternalLink, LogOut, Wallet, X } from "lucide-react";
import { createContext, useContext, useMemo, useState } from "react";
import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { seltraConfig } from "@/config/seltra.config";
import { compactAddress } from "@/lib/format";
import { activeChain } from "@/lib/wallet";

const WalletDialogContext = createContext<() => void>(() => undefined);

export function useWalletDialog() {
  return useContext(WalletDialogContext);
}

export function WalletDialogProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const { connectors, connect, isPending } = useConnect();
  const visibleConnectors = useMemo(
    () => connectors.filter((connector, index, all) => all.findIndex((item) => item.id === connector.id) === index),
    [connectors],
  );

  return (
    <WalletDialogContext.Provider value={() => setOpen(true)}>
      {children}
      {open ? (
        <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="wallet-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2 id="wallet-dialog-title">Connect wallet</h2>
              <button className="icon-button" type="button" onClick={() => setOpen(false)} aria-label="Close wallet dialog" title="Close">
                <X size={17} />
              </button>
            </div>
            <div className="connector-list">
              {visibleConnectors.map((connector) => (
                <button
                  key={connector.uid}
                  className="connector"
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    connect({ connector });
                    setOpen(false);
                  }}
                >
                  <span>{connector.name}</span>
                  <ChevronDown size={14} />
                </button>
              ))}
            </div>
            <p className="modal-note">Seltra requests a Permit2 approval once per token, never a standing approval to Seltra itself.</p>
          </div>
        </div>
      ) : null}
    </WalletDialogContext.Provider>
  );
}

export function WalletButton() {
  const [accountOpen, setAccountOpen] = useState(false);
  const { address, isConnected, chainId } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const { data: avaxBalance } = useBalance({ address });
  const wrongNetwork = isConnected && chainId !== seltraConfig.chainId;
  const openWalletDialog = useWalletDialog();

  if (wrongNetwork) {
    return (
      <button className="button warn" type="button" onClick={() => switchChain({ chainId: activeChain.id })}>
        Switch to Avalanche
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div className="wallet-wrap">
        <button className="wallet-connected" type="button" onClick={() => setAccountOpen((value) => !value)}>
          <span className="status-dot" />
          <span className="mono">{compactAddress(address)}</span>
          <ChevronDown size={14} />
        </button>
        {accountOpen ? (
          <div className="popover account-popover">
            <div>
              <span className="label">Address</span>
              <button className="copy-line" type="button" onClick={() => navigator.clipboard.writeText(address)}>
                {address}
                <Copy size={13} />
              </button>
            </div>
            <div className="balance-row">
              <span>AVAX</span>
              <strong className="number">{avaxBalance?.formatted ? Number(avaxBalance.formatted).toFixed(4) : "0.0000"}</strong>
            </div>
            <a className="popover-link" href={`${seltraConfig.explorerBaseUrl}/address/${address}`} target="_blank" rel="noreferrer">
              View on Snowtrace <ExternalLink size={13} />
            </a>
            <button className="popover-link danger" type="button" onClick={() => disconnect()}>
              Disconnect <LogOut size={13} />
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <button className="icon-button wallet-launcher" type="button" onClick={openWalletDialog} aria-label="Connect wallet" title="Connect wallet">
      <Wallet size={17} />
    </button>
  );
}
