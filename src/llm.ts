import Anthropic from "@anthropic-ai/sdk";

/**
 * The single integration point with the Anthropic API. Every other module
 * stays provider-agnostic and degrades to rule-based behaviour when the LLM is
 * unavailable, so the agent runs (and passes validation) with no API key.
 */

export const MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;

export function isLLMEnabled(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic();
  }
  return client;
}

interface StructuredArgs {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
}

interface TextArgs {
  system: string;
  user: string;
  maxTokens?: number;
}

/**
 * Run a request whose response is constrained to a JSON schema. Returns the
 * parsed object, or throws after one retry so the caller can fall back.
 */
export async function callStructured<T>(args: StructuredArgs): Promise<T> {
  const text = await withRetry(async () => {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: args.maxTokens ?? 2048,
      system: cachedSystem(args.system),
      output_config: { format: { type: "json_schema", schema: args.schema } },
      messages: [{ role: "user", content: args.user }],
    });
    return firstText(response);
  });

  return JSON.parse(text) as T;
}

/** Run a free-text generation request. Throws after one retry. */
export async function callText(args: TextArgs): Promise<string> {
  return withRetry(async () => {
    const response = await getClient().messages.create({
      model: MODEL,
      max_tokens: args.maxTokens ?? 1024,
      system: cachedSystem(args.system),
      messages: [{ role: "user", content: args.user }],
    });
    return firstText(response).trim();
  });
}

/** Cache the (large, stable) system prompt so repeated items reuse the prefix. */
function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

function firstText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === "text") {
      return block.text;
    }
  }
  throw new Error("LLM response contained no text block");
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError || isTransient(error)) {
      await delay(750);
      return fn();
    }
    throw error;
  }
}

function isTransient(error: unknown): boolean {
  return (
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
