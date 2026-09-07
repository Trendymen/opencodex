/** Wire-safe custom tool result lowering for this relay fork. */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function functionCallOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return JSON.stringify(output) ?? "";
  const text = output.map(part => {
    if (!isPlainObject(part)) return "";
    if (typeof part.text === "string") return part.text;
    if (part.type === "refusal" && typeof part.refusal === "string") return part.refusal;
    return "";
  }).filter(Boolean).join("\n");
  return text || JSON.stringify(output);
}
