import { redirect } from "next/navigation";
import { defaultTradePath } from "@/config/seltra.config";

export default function TradeRedirect() {
  redirect(defaultTradePath);
}

