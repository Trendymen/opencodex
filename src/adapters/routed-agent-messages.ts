/**
 * 将 Codex 的 agent_message 明文项改成公共 user message。
 * 部分第三方接口会拒绝该私有类型；是否转换由调用方的目的地、模型和配置策略决定。
 *
 * 密文和未知 part 保留原有失败保护，由 unreadable_encrypted_agent_task 和可选恢复路径处理。
 * 本函数只负责结构转换；字符串正文是否允许转换同样由调用方明确指定。
 */
export function normalizeRoutedAgentMessages(
  body: unknown,
  { allowStringContent = false }: { allowStringContent?: boolean } = {},
): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.input)) return body;
  let changed = false;
  const input = record.input.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const message = item as Record<string, unknown>;
    if (message.type !== "agent_message") return item;
    // xAI rejects the private item even when a complete child result is a plain string.
    // Trimming decides emptiness only; the original result bytes remain caller-owned.
    const content = allowStringContent && typeof message.content === "string" && message.content.trim().length > 0
      ? [{ type: "input_text", text: message.content }]
      : message.content;
    if (!Array.isArray(content) || content.length === 0) return item;
    // Genuine ciphertext and unknown part types must retain their existing fail-closed path.
    if (!content.every(part => part && typeof part === "object"
      && ["input_text", "input_image", "input_file"].includes(part.type))) return item;
    const identities = Object.fromEntries(["author", "recipient"]
      .filter(key => typeof message[key] === "string")
      .map(key => [key, message[key]]));
    changed = true;
    return {
      type: "message", role: "user",
      content: [
        ...(Object.keys(identities).length ? [{ type: "input_text", text: `Agent message ${JSON.stringify(identities)}` }] : []),
        ...content,
      ],
    };
  });
  return changed ? { ...record, input } : body;
}
