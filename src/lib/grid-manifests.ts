"use client";

import { useEffect, useState } from "react";
import { useAccount } from "wagmi";
import type { GridManifest } from "@seltra/sdk";
import { seltraConfig } from "@/config/seltra.config";

// Grid manifests are the only grid state that persists: order hashes plus the
// configuration that produced them. Signed payloads never reach storage.

const CHANGE_EVENT = "seltra:grids-changed";
const MAX_STORED_GRIDS = 50;

function storageKey(maker: string): string {
  return `seltra.grids.${seltraConfig.chainId}.${maker.toLowerCase()}`;
}

export function loadGridManifests(maker: string): GridManifest[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey(maker));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as GridManifest[]) : [];
  } catch {
    return [];
  }
}

export function saveGridManifest(manifest: GridManifest): void {
  if (typeof window === "undefined") return;
  const rest = loadGridManifests(manifest.maker).filter((entry) => entry.gridId !== manifest.gridId);
  const next = [manifest, ...rest].slice(0, MAX_STORED_GRIDS);
  try {
    window.localStorage.setItem(storageKey(manifest.maker), JSON.stringify(next));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // Storage full or blocked: the grid still exists on the API; only local grouping is lost.
  }
}

/** Manifests for the connected wallet, refreshed on save and cross-tab storage events. */
export function useGridManifests(): GridManifest[] {
  const { address } = useAccount();
  const [manifests, setManifests] = useState<GridManifest[]>([]);
  useEffect(() => {
    if (!address) {
      setManifests([]);
      return;
    }
    const refresh = () => setManifests(loadGridManifests(address));
    refresh();
    window.addEventListener(CHANGE_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(CHANGE_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, [address]);
  return manifests;
}
