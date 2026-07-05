/**
 * 执行工具 — Shell / Python / SQL / 时间 / 任务
 * 
 * 超时策略：空闲超时（Inactivity Timeout）
 *   - 命令持续产生输出 → 一直等待，不中断
 *   - 命令 N 秒无任何输出 → 判定卡死，超时中断
 *   - 硬上限 5 分钟作为安全网
 */
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync } from "child_process";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

// ── 超时配置 ──
const INACTIVITY_TIMEOUT = 30;   // 空闲超时（秒）：无输出超过此时间则判定卡死
const MAX_TIMEOUT = 300;         // 硬上限（秒）：无论如何最多运行 5 分钟

/**
 * 使用空闲超时执行子进程（异步）。
 * 
 * 与 spawnSync(timeout=N) 的区别：
 * - spawnSync: 硬超时 — N 秒后无条件杀死，即使命令在持续输出
 * - 本函数: 空闲超时 — 仅当 N 秒无输出时才杀死；命令持续输出则一直等待
 *           另有硬上限 MAX_TIMEOUT 作为安全网
 */
function runWithInactivityTimeout(
  cmd: string, cmdArgs: string[], cwd: string
): Promise<{ retcode: number | null; stdout: string; stderr: string; timeoutReason: string | null }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let lastActivity = Date.now();
    const startTime = Date.now();
    let timeoutReason: string | null = null;
    let settled = false;

    const inactivityTimer = setInterval(() => {
      if (settled) return;
      const idle = (Date.now() - lastActivity) / 1000;
      const total = (Date.now() - startTime) / 1000;
      if (idle > INACTIVITY_TIMEOUT) {
        timeoutReason = "inactivity";
        proc.kill();
        clearInterval(inactivityTimer);
      } else if (total > MAX_TIMEOUT) {
        timeoutReason = "max";
        proc.kill();
        clearInterval(inactivityTimer);
      }
    }, 500); // 500ms 轮询

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      lastActivity = Date.now();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      lastActivity = Date.now();
    });

    proc.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearInterval(inactivityTimer);
        resolve({
          retcode: code,
          stdout: Buffer.concat(stdoutChunks).toString("utf-8").trim(),
          stderr: Buffer.concat(stderrChunks).toString("utf-8").trim(),
          timeoutReason,
        });
      }
    });

    proc.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearInterval(inactivityTimer);
        resolve({
          retcode: null,
          stdout: "",
          stderr: String(err),
          timeoutReason: null,
        });
      }
    });
  });
}

registry.register("执行系统命令", RiskLevel.SYSTEM, Capability.SHELL,
  { workDir: "string", command: "string" },
  async function run_shell_command(workDir: string, args: Record<string, unknown>): Promise<string> {
    const cmd = String(args["command"]);
    // ── 阻塞命令检测 ──
    const blockingPatterns = [
      /\b(npm\s+start|npm\s+run\s+dev|npm\s+run\s+serve)\b/i,
      /\b(node\s+server|python\s+-m\s+http\.server|php\s+-S)\b/i,
      /\b(git\s+daemon|serve|run\s+server)\b/i,
      /\b(npx\s+.*serve|npx\s+.*start)\b/i,
    ];
    for (const pattern of blockingPatterns) {
      if (pattern.test(cmd)) {
        return `(x) 检测到阻塞命令: '${cmd}'\n该命令会启动长期运行的进程（如服务器），无法在工具执行超时内完成。\n\n建议:\n  1. 使用后台运行模式（如 npm start &）\n  2. 使用专门的验证工具检查服务是否正常`;
      }
    }
    const isWin = process.platform === "win32";
    const cmdArgs = isWin
      ? ["-NoProfile", "-NonInteractive", "-Command", cmd]
      : ["-c", cmd];
    const exe = isWin ? "powershell" : "bash";

    const { retcode, stdout, stderr, timeoutReason } = await runWithInactivityTimeout(exe, cmdArgs, workDir);

    if (timeoutReason === "inactivity") {
      const partial = (stdout + stderr).trim();
      const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
      return `(x) 空闲超时（命令 ${INACTIVITY_TIMEOUT}s 无任何输出，判定为卡死）\n命令: ${cmd}\n${partialMsg}\n\n可能的原因:\n  1. 命令启动了阻塞式进程（如服务器）等待输入\n  2. 命令在等待网络响应\n  3. 命令进入了交互模式`;
    } else if (timeoutReason === "max") {
      const partial = (stdout + stderr).trim();
      const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
      return `(x) 硬超时（命令执行超过 ${MAX_TIMEOUT}s 上限）\n命令: ${cmd}${partialMsg}`;
    }

    const out = (stdout + stderr).trim() || "(无输出)";
    return `exit=${retcode}\n${out}`;
  },
);

registry.register("执行 Python 代码", RiskLevel.SYSTEM, Capability.PYTHON,
  { workDir: "string", code: "string" },
  async function run_python(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const code = String(args["code"]);
    try {
      const rnd = Math.random().toString(36).slice(2, 8);
      const tmp = path.join(require("os").tmpdir(), `ctx_py_${Date.now()}_${rnd}.py`);
      fs.writeFileSync(tmp, code, "utf-8");
      try {
        const { retcode, stdout, stderr, timeoutReason } = await runWithInactivityTimeout("python", [tmp], _workDir);
        if (timeoutReason === "inactivity") {
          const partial = (stdout + stderr).trim();
          const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
          return `(x) 空闲超时（Python 代码 ${INACTIVITY_TIMEOUT}s 无输出，判定为卡死）\n可能的原因:\n  1. 代码中有 input() 等待用户输入\n  2. 代码在等待网络响应\n  3. 代码进入了死循环但不产生输出${partialMsg}`;
        } else if (timeoutReason === "max") {
          const partial = (stdout + stderr).trim();
          const partialMsg = partial ? `\n\n已捕获的部分输出:\n${partial.slice(0, 500)}` : "";
          return `(x) 硬超时（Python 代码执行超过 ${MAX_TIMEOUT}s 上限）${partialMsg}`;
        }
        const out = (stdout + stderr).trim().slice(0, 3000) || "(无输出)";
        return `exit=${retcode}\n${out}`;
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      }
    } catch (e) { return `(x) Python 沙箱异常: ${e}`; }
  },
);

registry.register("执行只读 SQL 查询", RiskLevel.SAFE, Capability.DB_READ,
  { workDir: "string", sql: "string" },
  function execute_sql_query(workDir: string, args: Record<string, unknown>): string {
    const sql = String(args["sql"]).trim().replace(/;$/, "");
    const dbPath = path.join(workDir, "agent.db");
    if (!fs.existsSync(dbPath)) return "(x) agent.db 不存在";
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath);
      const rows = db.prepare(sql).all();
      db.close();
      if (!rows.length) return "(空结果)";
      const cols = Object.keys(rows[0] as object);
      const lines = [cols.join(" | "), "-".repeat(cols.join(" | ").length)];
      for (const r of rows.slice(0, 50)) {
        lines.push(cols.map(c => String((r as Record<string, unknown>)[c])).join(" | "));
      }
      return `(${rows.length} 行)\n${lines.join("\n")}`;
    } catch (e) { return `(x) SQL 查询失败: ${e}`; }
  },
);

// 模块级任务存储
const _tasks: { id: string; subject: string; description: string; status: string }[] = [];

registry.register("创建待办任务", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", subject: "string", description: "string" },
  function task_create(_wd: string, args: Record<string, unknown>): string {
    const subject = String(args["subject"]);
    const desc = String(args["description"] || "");
    const tid = `task_${(_tasks.length + 1).toString().padStart(3, "0")}_${subject.slice(0, 10).replace(/\s/g, "_")}`;
    _tasks.push({ id: tid, subject, description: desc, status: "pending" });
    return `已创建 #${tid}: ${subject}`;
  },
);

registry.register("列出所有任务", RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function task_list(): string {
    if (!_tasks.length) return "(无任务)";
    return _tasks.map(t => `${t.id.padEnd(30)} [${t.status.padEnd(12)}] ${t.subject}`).join("\n");
  },
);

registry.register("更新任务状态", RiskLevel.SAFE, Capability.FS_WRITE,
  { workDir: "string", task_id: "string", status: "string" },
  function task_update(_wd: string, args: Record<string, unknown>): string {
    const tid = String(args["task_id"]);
    const st = String(args["status"]);
    for (const t of _tasks) {
      if (t.id === tid) {
        if (["pending", "in_progress", "completed", "deleted"].includes(st)) {
          t.status = st;
          return `任务 ${t.id} → ${st}`;
        }
        return `(x) 无效状态: ${st}`;
      }
    }
    return `(x) 未找到任务: ${tid}`;
  },
);
