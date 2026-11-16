import type { OcxConfig } from "../types";
import { compileModelConversions, ModelConversionConfigurationError } from "./model-conversion-config";
import { wrapModelConversionFetch, type ModelConversionFetch } from "./model-conversion-http";
import { wrapModelConversionWebsocket } from "./model-conversion-websocket";

export function createForkModelConversion<T>(config: () => OcxConfig): {
  active: boolean;
  wrap(options: Bun.Serve.Options<T>): Bun.Serve.Options<T>;
} {
  const rules = compileModelConversions(config().apiKeys ?? []);
  const active = [...rules.values()].some(value => value.length > 0);
  return {
    active,
    wrap(options) {
      if (!active) return options;
      if (typeof options.fetch !== "function") throw new ModelConversionConfigurationError();
      return {
        ...options,
        fetch: wrapModelConversionFetch(options.fetch as ModelConversionFetch<T>, { config, rules, boundBodyLimit: options.maxRequestBodySize }),
        ...(options.websocket ? { websocket: wrapModelConversionWebsocket(options.websocket, { config, rules, boundBodyLimit: options.maxRequestBodySize }) } : {}),
      } as Bun.Serve.Options<T>;
    },
  };
}
