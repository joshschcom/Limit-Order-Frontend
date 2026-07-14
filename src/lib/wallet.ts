import { coinbaseWallet, injected, walletConnect } from "wagmi/connectors";
import { createConfig, http } from "wagmi";
import { avalanche, avalancheFuji } from "wagmi/chains";
import { seltraConfig } from "@/config/seltra.config";

const chain = seltraConfig.chainId === 43114 ? avalanche : avalancheFuji;
const connectors = [
  injected({ shimDisconnect: true }),
  coinbaseWallet({ appName: "Seltra" }),
  ...(seltraConfig.walletConnectProjectId
    ? [walletConnect({ projectId: seltraConfig.walletConnectProjectId, showQrModal: true })]
    : []),
];

export const wagmiConfig = createConfig({
  chains: [avalancheFuji, avalanche],
  connectors,
  transports: {
    [avalancheFuji.id]: http(seltraConfig.chainId === 43113 ? seltraConfig.rpcUrl : undefined),
    [avalanche.id]: http(seltraConfig.chainId === 43114 ? seltraConfig.rpcUrl : undefined),
  },
  ssr: true,
});

export const activeChain = chain;
