"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** Hoverable/focusable info icon with a small explanation bubble. */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <span className="info-tip" tabIndex={0} aria-label="More information">
      <Info size={14} aria-hidden />
      <span role="tooltip" className="info-tip-bubble">{children}</span>
    </span>
  );
}
