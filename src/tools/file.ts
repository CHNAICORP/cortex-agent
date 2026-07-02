/**
 * 文件操作工具 — 与 Python tools.py 文件部分对应
 */
import * as fs from "fs";
import * as path from "path";
import { registry } from "../core/registry";
import { RiskLevel, Capability } from "../core/types";

registry.register(
  "列出目录内的文件和子目录",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", dirPath: "string" },
  function list_directory(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["dirPath"] || "./");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return `(x) 目录不存在: ${p}`;
    const items = fs.readdirSync(d);
    if (!items.length) return "(空目录)";
    const lines = [`(${items.length} 项)`];
    for (const x of items.sort()) {
      const stat = fs.statSync(path.join(d, x));
      lines.push(`  [${stat.isDirectory() ? "DIR" : "   "}] ${x}`);
    }
    return lines.join("\n");
  },
);

registry.register(
  "读取文本文件内容",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string", filePath: "string" },
  function read_file(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]);
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    if (!fs.existsSync(d)) return `(x) 不存在: ${p}`;
    if (fs.statSync(d).size > 102400) return "(x) 文件过大 (>100KB)";
    return fs.readFileSync(d, "utf-8");
  },
);

registry.register(
  "写入/覆盖文本文件",
  RiskLevel.WRITE, Capability.FS_WRITE,
  { workDir: "string", filePath: "string", content: "string" },
  function write_file(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["filePath"]);
    const content = String(args["content"]);
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    const parent = path.dirname(d);
    if (parent) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(d, content, "utf-8");
    return `已写入 ${p} (${content.length} 字符)`;
  },
);

registry.register(
  "获取当前系统日期时间",
  RiskLevel.SAFE, Capability.FS_READ,
  { workDir: "string" },
  function get_current_time(_workDir: string): string {
    return new Date().toISOString();
  },
);
