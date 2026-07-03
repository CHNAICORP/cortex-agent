/**
 * Cortex Agent — 核心类型定义
 * 与 Python cortex_agent.py 完全对应
 */

import { homedir } from "os";

// ── 风险等级 ──
export enum RiskLevel {
  SAFE = 0,
  WRITE = 1,
  SYSTEM = 2,
}

// ── 审计判决 ──
export enum AuditVerdict {
  ALLOW = "allow",
  WARN = "warn",
  CONFIRM = "confirm",
  DENY = "deny",
}

export const PERMISSION_MODES = ["standard", "auto", "yolo"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

// ── 能力令牌 ──
export enum Capability {
  FS_READ = "fs:read",
  FS_WRITE = "fs:write",
  DB_READ = "db:read",
  SHELL = "shell",
  PYTHON = "python",
  NET_HTTP = "net:http",
  NET_SEARCH = "net:search",
}

// ── 工具元数据 ──
export interface ToolMeta {
  description: string;
  risk: RiskLevel;
  capability: Capability;
}

// ── OpenAI Function Schema ──
export interface FunctionSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ── 工具实现 ──
export type ToolFn = (workDir: string, args: Record<string, unknown>) => string | Promise<string>;

// ── 步记录 ──
export interface StepRecord {
  step: number;
  timestamp: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resultPreview: string;
  success: boolean;
  riskLevel: string;
  capability: string;
  latencyMs: number;
}

// ── 轨迹 ──
export interface RunTrace {
  query: string;
  steps: StepRecord[];
  startTime: number;
  finalAnswer: string;
  stepLimitReached: boolean;
  error: string;
}

// ── LLM 消息 ──
export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── 缓存统计 ──
export interface CacheStats {
  calls: number;
  cacheHits: number;
  hitRate: number;
  totalInputTokens: number;
  totalCachedTokens: number;
}

// ── AgentConfig ──
export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  workDir: string;
  maxSteps: number;
  toolTimeout: number;
  systemPrompt: string;
  maxContextMsgs: number;
  loopTimeout: number;
  thinkTimeout: number;
  memoryDir: string;
  sessionsDir: string;
  skillsDir: string;
  autoExtractMemory: boolean;
  memoryEnabled: boolean;
  sessionsEnabled: boolean;
  permissionMode: PermissionMode;
  permissionRemember: boolean;
  workspaceOnly: boolean;
  contextLimit: number;
  maxTokens: number;
  maxInputTokens: number;
  // ── ContextGovernor 可调参数 (均可在 settings.json 中自定义) ──
  compressThreshold: number;
  compressHead: number;
  compressTail: number;
  safetyMargin: number;
  inputWarnPct: number;
  inputForcePct: number;
  // ── ToolExecutor 可调参数 ──
  maxResultChars: number;
  // ── Memory 注入控制 ──
  memoryInjectCount: number;
  // ── 长时运行参数 ──
  maxRounds: number;
  checkpointInterval: number;
  retryMax: number;
  retryBaseDelay: number;
  compactThreshold: number;
}

export function defaultWorkDir(): string {
  const { join } = require("path") as typeof import("path");
  return join(homedir(), ".cortx", "workspace");
}

export const DEFAULT_CONFIG: AgentConfig = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  workDir: defaultWorkDir(),
  maxSteps: 50,
  toolTimeout: 30,
  systemPrompt: "",
  maxContextMsgs: 50,
  loopTimeout: 600,
  thinkTimeout: 300,
  // ── Long-run parameters ──
  maxRounds: 0,              // 0=unlimited auto-continue
  checkpointInterval: 5,    // auto-save every N steps
  retryMax: 3,              // transient error retry count
  retryBaseDelay: 2.0,      // exponential backoff base delay (seconds)
  compactThreshold: 60,     // context compaction trigger
  memoryDir: "",
  sessionsDir: "",
  skillsDir: "",
  autoExtractMemory: true,
  memoryEnabled: true,
  sessionsEnabled: true,
  permissionMode: "standard",
  permissionRemember: true,
  workspaceOnly: false,
  contextLimit: 0,
  maxTokens: 0,
  maxInputTokens: 0,
  // ── ContextGovernor 可调参数 ──
  compressThreshold: 1500,
  compressHead: 600,
  compressTail: 400,
  safetyMargin: 4096,
  inputWarnPct: 80,
  inputForcePct: 90,
  // ── ToolExecutor 可调参数 ──
  maxResultChars: 2000,
  // ── Memory 注入控制 ──
  memoryInjectCount: 30,
};
