// ─── LLM Client — OpenAI-compatible, graceful fallback ───────────────────────
//
// Supports any OpenAI-compatible API: OpenAI, Together, Groq, Ollama, etc.
// Falls back silently to rule-based output when no key is configured.
//
// Env vars:
//   LLM_API_KEY   — required for LLM mode
//   LLM_BASE_URL  — default: https://api.openai.com/v1
//   LLM_MODEL     — default: gpt-4o-mini

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function hasLLM(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

export async function callLLM<T>(
  messages: LLMMessage[],
  fallback: T
): Promise<T> {
  const apiKey  = process.env.LLM_API_KEY;
  const baseUrl = process.env.LLM_BASE_URL ?? "https://api.openai.com/v1";
  const model   = process.env.LLM_MODEL    ?? "gpt-4o-mini";

  if (!apiKey) return fallback;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) return fallback;

    const data = await res.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    const content = data.choices[0]?.message?.content;
    if (!content) return fallback;

    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}
