export type OcxAgentTaskRecoveryConfig = {
  enabled?: boolean;
  /** ChatGPT model used by the recovery request. Default: gpt-5.6-luna. */
  model?: string;
  /** Reasoning effort sent to the recovery model. Default: medium. */
  reasoningEffort?: string;
  /** Per-attempt recovery request timeout in milliseconds. Default: 120000. */
  timeoutMs?: number;
  /** Number of bounded timeout retries after the first attempt. Default: 2. */
  maxRetries?: number;
  /** Maximum in-memory ciphertext-to-assignment entries. Default: 200. */
  cacheEntries?: number;
  /**
   * Extra recovery sends when ChatGPT rejects with a transient 5xx or the transport
   * fails, sharing the same credential, deadline, and cache flight (#3661).
   * Default: 0 (single attempt); maximum: 2.
   */
  retries?: number;
};
