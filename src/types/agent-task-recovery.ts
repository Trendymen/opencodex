export type OcxAgentTaskRecoveryConfig = {
  enabled?: boolean;
  /** ChatGPT model used by the recovery request. Default: gpt-5.6-luna. */
  model?: string;
  /** Reasoning effort sent to the recovery model. Default: medium. */
  reasoningEffort?: string;
  /** Milliseconds per strict backend attempt (default 120000), or per ordinary recovery (default 45000). */
  timeoutMs?: number;
  /** Extra timeout attempts for admitted strict backend tasks only. Default: 2. */
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
