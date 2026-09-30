/** Provider-neutral user-visible progress guidance for routed tool-using models. */

export const ROUTED_PROGRESS_CONTRACT_SENTINEL =
  "ordinary assistant text message before the first tool call";

export const ROUTED_PROGRESS_CONTRACT = [
  "User-visible progress contract for tool-using tasks:",
  `For every task that requires tools, send an ${ROUTED_PROGRESS_CONTRACT_SENTINEL}.`,
  "Keep that update concise and state what you are about to inspect or change.",
  "During ongoing work, send another brief assistant update after meaningful milestones, before long operations, after no more than four consecutive tool-only responses, and promptly after a new user message arrives.",
  "A tool call by itself is not a progress update.",
  "Do not mention protocol-specific message categories in the text.",
  "Unless the user explicitly requests silence or a different cadence, do not leave the user without visible progress.",
  "When the task is complete, send a self-contained assistant response with the result.",
].join(" ");

const GPT_CHANNEL_OVERVIEW = [
  "You have two channels for staying in conversation with the user:",
  "- You share updates in the `commentary` channel.",
  "- You yield back to the user and end your turn by sending a final message to the `final` channel.",
].join("\n");

const ROUTED_CHANNEL_OVERVIEW = [
  "Stay in conversation with the user through ordinary assistant text messages.",
  "- Send concise user-visible progress updates while work continues.",
  "- When you yield back after completing the work, send one self-contained assistant response with the result.",
  "The host decides how assistant messages are presented; do not name or target protocol-specific channels.",
].join("\n");

const GPT_INTERMEDIATE_COMMENTARY_SECTION = [
  "## Intermediate commentary",
  "",
  "As you work, you send messages to the `commentary` channel. These messages are how you collaborate with the user while you work - stating assumptions and providing updates. These messages should be concise and quickly scannable. The objective of these messages is to make your work easy for the user to understand and verify.",
  "",
  "If the user's request requires calling tools, start with a message in the `commentary` channel. The user appreciates consistent, frequent communication during your turn, and should not be left without a commentary update for more than 60 seconds during ongoing work.",
  "",
  "Do NOT put a final response (e.g. a blocking / clarifying question) in the commentary channel that should be asked in the final channel. Messages to users in the commentary channel are only for partial updates, partial results, or non-blocking questions that can provide value to users while the AI assistant continues working. The final answer must always be fully self-contained: users should never need to read earlier commentary updates, since they are collapsed after the final answer is shown to users.",
].join("\n");

const ROUTED_PROGRESS_SECTION = [
  "## User-visible progress",
  "",
  "As you work, use concise ordinary assistant text messages to state assumptions and provide updates that help the user understand and verify the work.",
  "",
  "For tool-using work, follow the user-visible progress contract at the end of these instructions. Keep ongoing updates separate from the self-contained assistant response that reports the completed result.",
  "",
  "Do not name or attempt to select protocol-specific message channels; the host owns presentation and classification.",
].join("\n");

const GPT_COMPACTION_COMMENTARY_SENTENCE =
  "Do not redo completely finished work or repeat already delivered commentary updates; treat a turn spanning compactions as one logical chain of events.";
const ROUTED_COMPACTION_PROGRESS_SENTENCE =
  "Do not redo completely finished work or repeat already delivered progress updates; treat a turn spanning compactions as one logical chain of events.";

export function neutralizeRoutedChannelInstructions(text: string): string {
  return text
    .replace(GPT_CHANNEL_OVERVIEW, ROUTED_CHANNEL_OVERVIEW)
    .replace(GPT_INTERMEDIATE_COMMENTARY_SECTION, ROUTED_PROGRESS_SECTION)
    .replace(GPT_COMPACTION_COMMENTARY_SENTENCE, ROUTED_COMPACTION_PROGRESS_SENTENCE)
    .replace(
      "Explicitly tell the user in the `commentary` channel whenever a skill causes you to take an action or pause your work.",
      "Explicitly tell the user in an ordinary assistant text message whenever a skill causes you to take an action or pause your work.",
    )
    .replace(
      "- First, tell the user in the commentary channel **why** you are using the skill.",
      "- First, tell the user in ordinary assistant text **why** you are using the skill.",
    );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasRoutedProgressContract(value: unknown): boolean {
  return typeof value === "string" && value.includes(ROUTED_PROGRESS_CONTRACT);
}

export function appendRoutedProgressContract(text: string): string {
  if (hasRoutedProgressContract(text)) return text;
  return text.length > 0 ? `${text}\n\n${ROUTED_PROGRESS_CONTRACT}` : ROUTED_PROGRESS_CONTRACT;
}

export function finalizeRoutedToolPrompt(text: string): string {
  return appendRoutedProgressContract(neutralizeRoutedChannelInstructions(text));
}

export function appendRoutedProgressContractPart(parts: readonly string[]): string[] {
  const neutralized = parts.map(neutralizeRoutedChannelInstructions);
  return neutralized.some(hasRoutedProgressContract)
    ? neutralized
    : [...neutralized, ROUTED_PROGRESS_CONTRACT];
}

function responsesBodyHasTools(body: Record<string, unknown>): boolean {
  if (Array.isArray(body.tools) && body.tools.length > 0) return true;
  if (!Array.isArray(body.input)) return false;
  return body.input.some(item => isPlainObject(item)
    && item.type === "additional_tools"
    && Array.isArray(item.tools)
    && item.tools.length > 0);
}

/** Append the contract only to tool-using public Responses requests with string instructions. */
export function applyRoutedProgressContractToResponsesBody(body: unknown): unknown {
  if (!isPlainObject(body) || !responsesBodyHasTools(body)) return body;
  if (typeof body.instructions !== "string") return body;
  const instructions = finalizeRoutedToolPrompt(body.instructions);
  return instructions === body.instructions ? body : { ...body, instructions };
}
