/**
 * LLM Provider — DeepSeek / OpenAI / GLM（智谱）流式 + 非流式
 * 与 Python llm.py 完全对应
 */
import { Message, FunctionSchema, CacheStats } from './types.js';

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  tools: FunctionSchema[];
  timeout: number;
  maxTokens: number;
}

interface ParsedToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type { ParsedToolCall };

interface LLMResponse {
  text: string;
  toolCalls: ParsedToolCall[] | null;
  reasoning: string;
  finishReason: string;
}

const DEFAULT_PROVIDERS: Record<string, { baseUrl: string; models: Record<string, string> }> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    models: { flash: "deepseek-v4-flash", pro: "deepseek-v4-pro" },
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: {},
  },
  glm: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    models: {},  // 无别名 — glm-5.2 / glm-5.2-flash 直接作为模型名使用
  },
};

// ── Model Capabilities Registry ──
// 每个模型的实际上下文窗口和最大输出 token 数。
// contextLimit=0 或 maxTokens=0 时自动从此注册表解析。
interface ModelCaps { contextWindow: number; maxOutputTokens: number; }

const MODEL_CAPABILITIES: Record<string, ModelCaps> = {
  // DeepSeek V4 系列 — 1M 上下文窗口
  "deepseek-v4-flash":  { contextWindow: 1_000_000, maxOutputTokens: 8192 },
  "deepseek-v4-pro":   { contextWindow: 1_000_000, maxOutputTokens: 8192 },
  // GLM 系列 — 1M 上下文窗口
  "glm-5.2":            { contextWindow: 1_000_000, maxOutputTokens: 4096 },
  "glm-5.2-flash":     { contextWindow: 1_000_000, maxOutputTokens: 4096 },
  // OpenAI 系列
  "gpt-4o":             { contextWindow: 128_000,   maxOutputTokens: 16384 },
  "gpt-4o-mini":        { contextWindow: 128_000,   maxOutputTokens: 16384 },
};

// 按前缀匹配的默认能力
const PREFIX_DEFAULTS: Array<[string, ModelCaps]> = [
  ["deepseek",  { contextWindow: 1_000_000, maxOutputTokens: 8192 }],
  ["glm",       { contextWindow: 1_000_000, maxOutputTokens: 4096 }],
  ["gpt-4",     { contextWindow: 128_000,   maxOutputTokens: 16384 }],
  ["gpt-3.5",   { contextWindow: 16_000,    maxOutputTokens: 4096 }],
];

const FALLBACK_CAPS: ModelCaps = { contextWindow: 128_000, maxOutputTokens: 8192 };

export function resolveCapabilities(model: string): ModelCaps {
  const m = model.toLowerCase().trim();
  if (MODEL_CAPABILITIES[m]) return MODEL_CAPABILITIES[m];
  for (const [prefix, caps] of PREFIX_DEFAULTS) {
    if (m.startsWith(prefix)) return caps;
  }
  return FALLBACK_CAPS;
}

let activeProvider = "deepseek";
let activeBaseUrl = "https://api.deepseek.com/v1";

export function setupProviders(providers?: Record<string, { baseUrl: string; models: Record<string, string> }>, active?: string) {
  if (providers) Object.assign(DEFAULT_PROVIDERS, providers);
  if (active) {
    activeProvider = active;
    activeBaseUrl = DEFAULT_PROVIDERS[active]?.baseUrl || activeBaseUrl;
  }
}

export function resolveModel(name: string): string {
  const provider = DEFAULT_PROVIDERS[activeProvider];
  if (provider?.models[name]) return provider.models[name];
  for (const p of Object.values(DEFAULT_PROVIDERS)) {
    if (p.models[name]) return p.models[name];
  }
  return name;
}

export class LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  model: string;
  private tools: FunctionSchema[];
  private timeout: number;
  private maxTokens: number;

  /** 根据当前 provider 生成 thinking 参数。
   * GLM 使用 thinking_budget，DeepSeek/OpenAI 使用 reasoning_effort。
   */
  private _thinkingBody(thinking: boolean): Record<string, unknown> {
    if (!thinking) return {};
    if (activeProvider === "glm") {
      return { extra_body: { thinking: { type: "enabled", thinking_budget: "max" } } };
    }
    return { extra_body: { thinking: { type: "enabled" } }, reasoning_effort: "max" };
  }

  // 缓存统计
  private callCount = 0;
  private cacheHits = 0;
  private totalInputTokens = 0;
  private totalCachedTokens = 0;

  constructor(config: LLMConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.tools = config.tools;
    this.timeout = config.timeout;
    this.maxTokens = config.maxTokens;
  }

  get cacheStats(): CacheStats {
    return {
      calls: this.callCount,
      cacheHits: this.cacheHits,
      hitRate: this.callCount > 0 ? (this.cacheHits / this.callCount) * 100 : 0,
      totalInputTokens: this.totalInputTokens,
      totalCachedTokens: this.totalCachedTokens,
    };
  }

  async call(messages: Message[], thinking = true): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      max_tokens: this.maxTokens,
    };
    Object.assign(body, this._thinkingBody(thinking));

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    const data: Record<string, unknown> = await resp.json() as Record<string, unknown>;
    this.callCount++;
    if (data.usage) {
      const usage = data.usage as Record<string, unknown>;
      this.totalInputTokens += (usage.prompt_tokens as number) || 0;
      const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
      const cached = (details?.cached_tokens as number) || 0;
      this.totalCachedTokens += cached;
      if (cached > 0) this.cacheHits++;
    }

    const choice = (data.choices as Array<{ message?: Record<string, unknown>; finish_reason?: string }>)?.[0];
    const msg = choice?.message;
    const text: string = (msg?.content as string) || "";
    const reasoning: string = (msg?.reasoning_content as string) || "";
    const finishReason: string = choice?.finish_reason || "";

    let toolCalls: ParsedToolCall[] | null = null;
    if (msg?.tool_calls) {
      toolCalls = (msg.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>).map(tc => {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* malformed JSON from LLM */ }
        return { id: tc.id, name: tc.function.name, args };
      });
    }

    return { text, toolCalls, reasoning, finishReason };
  }

  async callStream(
    messages: Message[],
    onText?: (t: string) => void,
    onAnswer?: (t: string) => void,
    thinking = true,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools: this.tools.length > 0 ? this.tools : undefined,
      max_tokens: this.maxTokens,
      stream: true,
    };
    Object.assign(body, this._thinkingBody(thinking));

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout * 1000),
    });

    const reader = resp.body?.getReader();
    const decoder = new TextDecoder();
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolBuf: Map<number, { id: string; name: string; argsJson: string }> = new Map();
    let reasoningDone = false;
    let finishReason = "";

    if (!reader) return { text: "", toolCalls: null, reasoning: "", finishReason };

    let lineBuf = "";  // 缓冲跨 chunk 的不完整 SSE 行
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      lineBuf += chunk;
      const lines = lineBuf.split("\n");
      // 最后一个元素可能是不完整的行，保留到下次处理
      lineBuf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
            if (onText) onText(delta.reasoning_content);
          }
          if (delta.content) {
            if (!reasoningDone && onAnswer) { onAnswer(""); reasoningDone = true; }
            textParts.push(delta.content);
            if (onAnswer) onAnswer(delta.content);
          }
          if (delta.tool_calls) {
            for (const tcd of delta.tool_calls) {
              const idx = tcd.index;
              if (!toolBuf.has(idx)) toolBuf.set(idx, { id: "", name: "", argsJson: "" });
              const tb = toolBuf.get(idx)!;
              if (tcd.id) tb.id = tcd.id;
              if (tcd.function?.name) tb.name += tcd.function.name;
              if (tcd.function?.arguments) tb.argsJson += tcd.function.arguments;
            }
          }
        } catch { /* skip malformed chunks */ }
      }
    }
    // 处理缓冲区中剩余的最后一行
    if (lineBuf.startsWith("data: ")) {
      const data = lineBuf.slice(6);
      if (data !== "[DONE]") {
        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          if (delta?.reasoning_content) {
            reasoningParts.push(delta.reasoning_content);
            if (onText) onText(delta.reasoning_content);
          }
          if (delta?.content) {
            if (!reasoningDone && onAnswer) { onAnswer(""); reasoningDone = true; }
            textParts.push(delta.content);
            if (onAnswer) onAnswer(delta.content);
          }
          if (delta?.tool_calls) {
            for (const tcd of delta.tool_calls) {
              const idx = tcd.index;
              if (!toolBuf.has(idx)) toolBuf.set(idx, { id: "", name: "", argsJson: "" });
              const tb = toolBuf.get(idx)!;
              if (tcd.id) tb.id = tcd.id;
              if (tcd.function?.name) tb.name += tcd.function.name;
              if (tcd.function?.arguments) tb.argsJson += tcd.function.arguments;
            }
          }
        } catch { /* skip malformed */ }
      }
    }

    this.callCount++;
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
    this.totalInputTokens += Math.floor(totalChars * 0.4);

    const text = textParts.join("");
    const reasoning = reasoningParts.join("");
    let toolCalls: ParsedToolCall[] | null = null;
    if (toolBuf.size > 0) {
      toolCalls = [];
      for (const [, tb] of [...toolBuf.entries()].sort((a, b) => a[0] - b[0])) {
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(tb.argsJson || "{}"); } catch { /* malformed JSON from LLM streaming */ }
        toolCalls.push({
          id: tb.id,
          name: tb.name,
          args,
        });
      }
    }
    return { text, toolCalls, reasoning, finishReason };
  }

  switch(alias: string): void {
    this.model = resolveModel(alias);
  }

  updateMaxTokens(maxTokens: number): void {
    this.maxTokens = maxTokens;
  }

  static resolve = resolveModel;
  static setupProviders = setupProviders;
}
