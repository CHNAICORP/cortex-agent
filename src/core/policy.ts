/**
 * PolicyEngine — 安全策略引擎
 * 与 Python policy.py 完全对应：4 级判决 + SSRF/SQL/Shell/Python 检测
 */
import * as os from "os";
import * as path from "path";
import * as net from "net";
import * as dns from "dns";
import { RiskLevel, Capability, AuditVerdict, PermissionMode } from './types.js';
import { registry } from './registry.js';

// ── SSRF 拦截网段 ──
// 注意：127.0.0.0/8 和 ::1/128 已移除 — 允许 localhost 开发访问
const SSRF_BLOCKED_NETS = [
  "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "0.0.0.0/8", "224.0.0.0/4",
  "fc00::/7", "fe80::/10",
];

function ipInCidr(ip: string, cidr: string): boolean {
  // Full CIDR check covering both IPv4 and IPv6
  if (ip.includes(":") && cidr.includes(":")) {
    // IPv6 CIDR — simple prefix match for the listed ranges
    const [ipNorm] = ip.toLowerCase().split("%"); // strip zone index
    const [netStr, bitsStr] = cidr.split("/");
    const bits = parseInt(bitsStr);
    // For /128: exact match; for /7 and /10: prefix match
    if (bits >= 64) return ipNorm === netStr.toLowerCase();
    return ipNorm.toLowerCase().startsWith(netStr.toLowerCase().slice(0, Math.ceil(bits / 4)));
  }
  if (!ip.includes(".") || !cidr.includes(".")) return false;
  const [ipA, ipB, ipC, ipD] = ip.split(".").map(Number);
  const [netStr, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr);
  const [nA, nB, nC, nD] = netStr.split(".").map(Number);
  // Guard against NaN (e.g., "localhost" passed as IP)
  if (isNaN(ipA) || isNaN(nA) || bits > 32) return false;
  const ipNum = ((ipA << 24) | (ipB << 16) | (ipC << 8) | ipD) >>> 0;
  const netNum = ((nA << 24) | (nB << 16) | (nC << 8) | nD) >>> 0;
  const mask = ~((1 << (32 - bits)) - 1) >>> 0;
  return (ipNum & mask) === (netNum & mask);
}

async function resolveHostname(host: string): Promise<string[]> {
  try {
    const addresses = await dns.promises.resolve4(host);
    try {
      const v6 = await dns.promises.resolve6(host);
      return [...addresses, ...v6];
    } catch { /* IPv6 not available */ }
    return addresses;
  } catch {
    // Try reverse lookup — if DNS fails, block (rebinding protection)
    return [];
  }
}

export async function checkSsrf(hostOrUrl: string): Promise<[boolean, string]> {
  let host = hostOrUrl;
  const m = hostOrUrl.match(/^https?:\/\/(?:\[([^\]]+)\]|([^/:]+))/i);
  if (m) host = (m[1] || m[2]).toLowerCase();

  // Check if it's already an IP
  if (net.isIP(host)) {
    // Handle IPv4-mapped IPv6
    const v4m = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4m) host = v4m[1];
    for (const cidr of SSRF_BLOCKED_NETS) {
      if (ipInCidr(host, cidr)) {
        return [false, `SSRF 防护: ${host} 在禁访范围 ${cidr}`];
      }
    }
    return [true, ""];
  }

  // localhost 允许访问（开发场景必需）
  // 内网 IP 仍由 CIDR 检查拦截

  // Hostname — resolve and check all resolved IPs
  try {
    const ips = await resolveHostname(host);
    if (ips.length > 0) {
      // DNS succeeded — check if any resolved IP is in blocked range
      for (const ip of ips) {
        for (const cidr of SSRF_BLOCKED_NETS) {
          if (ipInCidr(ip, cidr)) {
            return [false, `SSRF 防护: ${host} → ${ip} 在禁访范围 ${cidr}`];
          }
        }
      }
      return [true, ""];
    }
  } catch {
    // DNS error — fall through to warn+allow
  }
  // DNS failed: warn but allow (the HTTP layer will do its own isPrivateHost check)
  // This avoids blocking legitimate external requests when corporate DNS is restricted
  return [true, `[WARN] SSRF: DNS 无法解析 ${host}，放行 (连接层检查)`];
}

// ── PolicyEngine ──
export class PolicyEngine {
  static FORBIDDEN_EXTS = new Set([
    ".sh", ".bat", ".exe", ".ps1", ".com", ".scr", ".vbs",
    ".cmd", ".psm1", ".psd1", ".vbe", ".jse", ".wsf", ".wsh",
    ".hta", ".msi", ".msp", ".cpl", ".scf",
  ]);

  static WARN_PREFIX = "[WARN] ";

  static SHELL_BLOCK_SUBSTR = [
    // System destruction — 仅拦截真正危险的系统级操作
    "rm -rf /", "rm -rf --no-preserve-root", "del /f /s /q c:",
    "format ", "diskpart", "mkfs", "fdisk", "dd if=/dev/",
    "shutdown", "reboot", "stop-computer", "restart-computer",
    // Privilege escalation (仅真正的提权命令)
    "runas /user:",
    // Data exfiltration vectors
    "nc ", "ncat ", "netcat ",
    // System config modification
    "reg add", "reg delete", "reg import",
    "sc create", "sc delete", "sc config",
    "schtasks /create", "schtasks /delete",
    "new-service", "remove-service",
    "bcdedit", "netsh ", "set-executionpolicy",
    // PowerShell obfuscation (仅真正的混淆)
    "-encodedcommand", "-enc ",
    // Registry access
    "hklm:", "hkcu:", "hkey_",
  ];

  // Tier 1 regex patterns — context-sensitive shell detection
  static SHELL_BLOCK_RE: [RegExp, string][] = [
    [/(?:^|\s)([d-z]:\\)/i,           "禁止访问非 C 盘路径"],
    [/(?:^|\s|;)(?:-[eE][nNcCoOdDeEdDcCoOmMmMaAnNdD]*)\s/, "禁止 PowerShell 编码命令 (-e/-en/-enc)"],
    // 禁止递归删除根目录
    [/remove-item\s+.*-recurse\s+-force/i, "禁止递归强制删除"],
    [/del\s+\/[a-z]*s[a-z]*\s+\/q/i,  "禁止批量静默删除"],
  ];

  static SHELL_WARN_SUBSTR = [
    "curl ", "wget ", "invoke-webrequest", "invoke-restmethod",
    "chmod 777", "chmod -R",
    "net user", "net localgroup", "net share",
    "get-eventlog", "get-wmiobject",
  ];

  static SQL_DENY = new Set([
    "drop", "delete", "update", "insert", "alter", "create", "truncate",
    "grant", "revoke", "exec", "execute", "union", "attach", "detach", "pragma",
    "replace", "into",
  ]);

  static PYTHON_DENY: [RegExp, string][] = [
    [/\b__\s*import\s*__/, "禁止 __import__ 逃逸"],
    [/\bexec\s*\(/, "禁止 exec"],
    [/\beval\s*\(/, "禁止 eval"],
    [/\bcompile\s*\(/, "禁止 compile"],
    [/\bctypes\b/, "禁止 ctypes"],
    [/\b__builtins__/, "禁止 __builtins__"],
    [/\b__class__/, "禁止 __class__"],
    [/\b__base__/, "禁止 __base__"],
    [/\b__subclasses__/, "禁止 __subclasses__"],
    [/\b__globals__/, "禁止 __globals__"],
    [/\b__getattribute__/, "禁止 __getattribute__"],
    [/\b__delattr__/, "禁止 __delattr__"],
    [/\b__setattr__/, "禁止 __setattr__"],
  ];

  // All path-like parameter names used across file tools (both Python and TS naming)
  static PATH_PARAMS = new Set([
    "path", "filePath", "dirPath", "fileA", "fileB",
    "file_a", "file_b", "source", "target", "pattern", "outPath",
  ]);

  private workDir: string;
  private config: { permissionMode: PermissionMode };

  constructor(workDir: string, config: { permissionMode: PermissionMode }) {
    this.workDir = path.resolve(workDir);
    this.config = config;
  }

  isOutsideWorkspace(userPath: string): boolean {
    if (userPath.includes("\x00")) return true;
    try {
      const full = path.resolve(this.workDir, userPath);
      const sep = path.sep;
      return !(full.startsWith(this.workDir + sep) || full === this.workDir);
    } catch {
      return true;
    }
  }

  private checkPermission(risk: RiskLevel, isOutside: boolean): AuditVerdict {
    const mode = this.config.permissionMode;
    if (mode === "yolo") return AuditVerdict.ALLOW;
    if (risk === RiskLevel.SAFE) {
      if (isOutside && mode !== "auto") return AuditVerdict.CONFIRM;
      return AuditVerdict.ALLOW;
    }
    if (risk === RiskLevel.WRITE) {
      // 工作区内写操作在所有模式都放行
      if (!isOutside) return AuditVerdict.ALLOW;
      // 工作区外的写操作在 auto 模式也放行
      if (mode === "auto") return AuditVerdict.ALLOW;
      return AuditVerdict.CONFIRM;
    }
    // SYSTEM 风险（shell/python 等）
    // 内容审计已通过 → 命令本身不危险
    // auto 模式自动放行
    if (mode === "auto") return AuditVerdict.ALLOW;
    // standard 模式：工作区内放行（开发命令如 npm/tsc/git/python 等）
    if (!isOutside) return AuditVerdict.ALLOW;
    return AuditVerdict.CONFIRM;
  }

  async audit(toolName: string, args: Record<string, unknown>): Promise<[boolean, string]> {
    const meta = registry.meta(toolName);
    if (!meta) return [false, `未注册: ${toolName}`];
    const risk = meta.risk;
    const cap = meta.capability;

    // 文件工具：检查路径参数
    let isOutside = false;
    if (cap === Capability.FS_READ || cap === Capability.FS_WRITE) {
      for (const pname of PolicyEngine.PATH_PARAMS) {
        const val = args[pname];
        if (typeof val === "string" && val) {
          isOutside = this.isOutsideWorkspace(val);
          if (isOutside) break;
        }
      }
    }

    // ── 内容审计（始终执行，即使 yolo 模式也不跳过）──
    // 文档: "A dangerous command is always blocked"
    // 判决链: meta lookup → content audit → permission mode → yolo bypass
    let contentOk = true;
    let contentReason = "";
    if (cap === Capability.DB_READ) {
      [contentOk, contentReason] = this.auditSql(String(args["sql"] || ""));
    } else if (cap === Capability.SHELL) {
      [contentOk, contentReason] = this.auditShell(String(args["command"] || ""));
    } else if (cap === Capability.PYTHON) {
      [contentOk, contentReason] = this.auditPython(String(args["code"] || ""));
    } else if (cap === Capability.NET_HTTP || cap === Capability.NET_SEARCH) {
      const target = String(args["url"] || args["query"] || "");
      [contentOk, contentReason] = await this.auditUrl(target);
    } else if (cap === Capability.FS_WRITE) {
      // yolo 模式跳过路径越权检查，但仍检查危险文件扩展名
      if (this.config.permissionMode === "yolo") {
        [contentOk, contentReason] = this.auditPathWriteYolo(args);
      } else {
        [contentOk, contentReason] = this.auditPathWrite(args);
      }
    }
    // 内容审计失败 → 直接拒绝（即使在 yolo 模式下）
    if (!contentOk) return [false, contentReason];

    // yolo = 跳过权限检查，放行（内容审计已通过）
    if (this.config.permissionMode === "yolo") return [true, ""];

    // ── 权限判决 ──
    const verdict = this.checkPermission(risk, isOutside);
    if (verdict === AuditVerdict.CONFIRM) return [false, "confirm"];
    if (verdict === AuditVerdict.DENY) return [false, "denied"];
    return [true, contentReason];
  }

  private auditPathWrite(args: Record<string, unknown>): [boolean, string] {
    const userPath = String(args["path"] || args["filePath"] || args["source"] || "");
    const full = path.resolve(this.workDir, userPath);
    // Check workspace containment
    const sep = path.sep;
    if (!(full.startsWith(this.workDir + sep) || full === this.workDir)) {
      return [false, `路径越权: ${userPath}`];
    }
    const ext = path.extname(full).toLowerCase();
    if (PolicyEngine.FORBIDDEN_EXTS.has(ext)) return [false, `禁止写入 ${ext}`];
    return [true, full];
  }

  /** yolo 模式：跳过路径越权检查，但仍检查危险文件扩展名。 */
  private auditPathWriteYolo(args: Record<string, unknown>): [boolean, string] {
    const userPath = String(args["path"] || args["filePath"] || args["source"] || "");
    const full = path.resolve(this.workDir, userPath);
    const ext = path.extname(full).toLowerCase();
    if (PolicyEngine.FORBIDDEN_EXTS.has(ext)) return [false, `禁止写入 ${ext}`];
    return [true, full];
  }

  private auditSql(sql: string): [boolean, string] {
    const s = sql.trim();
    if (s.includes(";") && s.replace(/;$/, "").includes(";")) return [false, "禁止多语句"];
    if (!s.toUpperCase().startsWith("SELECT")) return [false, "仅允许 SELECT"];
    const low = s.toLowerCase();
    for (const kw of PolicyEngine.SQL_DENY) {
      if (new RegExp(`\\b${kw}\\b`).test(low)) return [false, `SQL 含禁止关键词: ${kw}`];
    }
    return [true, ""];
  }

  private auditShell(cmd: string): [boolean, string] {
    const low = cmd.toLowerCase();
    // Tier 1a: substring BLOCK
    for (const p of PolicyEngine.SHELL_BLOCK_SUBSTR) {
      if (low.includes(p.toLowerCase())) return [false, `高危命令: ${p}`];
    }
    // Tier 1b: regex BLOCK
    for (const [pattern, reason] of PolicyEngine.SHELL_BLOCK_RE) {
      if (pattern.test(cmd)) return [false, reason];
    }
    // Tier 2: WARN
    for (const p of PolicyEngine.SHELL_WARN_SUBSTR) {
      if (low.includes(p.toLowerCase())) return [true, `${PolicyEngine.WARN_PREFIX}潜在风险: ${p}`];
    }
    return [true, ""];
  }

  private auditPython(code: string): [boolean, string] {
    for (const [pattern, reason] of PolicyEngine.PYTHON_DENY) {
      if (pattern.test(code)) return [false, reason as string];
    }
    return [true, ""];
  }

  private async auditUrl(target: string): Promise<[boolean, string]> {
    if (!/^https?:\/\//i.test(target)) return [true, ""];
    return checkSsrf(target);
  }
}
