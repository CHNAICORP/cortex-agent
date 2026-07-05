/**
 * Tool Context — 全局工具上下文
 * 
 * 允许工具函数访问 Agent 级别的功能（如用户交互、子代理生成），
 * 而不需要修改 ToolFn 签名。
 * 
 * 与 Python tool_context.py 对应
 */

export interface ToolContext {
  /** 向用户提问并获取回答（交互模式） */
  askUser?: (question: string) => Promise<string>;
  /** 生成子代理执行独立任务 */
  spawnSubagent?: (task: string, model?: string) => Promise<string>;
  /** 当前工作目录 */
  workDir?: string;
  /** 是否为非交互模式（管道/CI） */
  nonInteractive?: boolean;
  /** 当前 Agent 配置（只读引用） */
  agentConfig?: Record<string, unknown>;
}

const _ctx: ToolContext = {};

export function setToolContext(ctx: Partial<ToolContext>): void {
  Object.assign(_ctx, ctx);
}

export function getToolContext(): ToolContext {
  return _ctx;
}

export function clearToolContext(): void {
  for (const k of Object.keys(_ctx)) {
    delete (_ctx as Record<string, unknown>)[k];
  }
}
