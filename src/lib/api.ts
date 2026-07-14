import { SeltraApi } from "@seltra/sdk";
import { seltraConfig } from "@/config/seltra.config";

/** Singleton API client: one REST base + one shared WebSocket for the whole app. */
export const seltraApi = new SeltraApi(seltraConfig.api);
