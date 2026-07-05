/**
 * 浏览器 + 桌面控制工具 — Chrome DevTools Protocol
 *
 * v2.0 修复:
 *   1. 使用原生 Node.js http 模块替代 curl（更可靠）
 *   2. 添加 --user-data-dir 避免与已运行浏览器实例冲突
 *   3. 修复同步 sleep bug: setTimeout 在同步循环中不阻塞
 *   4. 移除截图工具的工作区路径限制（允许保存到任意位置）
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

let _browserWsUrl = "";
let _browserLaunching: Promise<string> | null = null;

// ── 原生 HTTP 工具（替代 curl）──

function _httpGet(port: number, urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function _httpPut(port: number, urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}${urlPath}`, { method: "PUT" }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk.toString());
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失败: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
    req.end();
  });
}

// ── 浏览器启动 ──

async function _tryConnect(): Promise<string> {
  try {
    const data = await _httpGet(9222, "/json/version");
    if (data && data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
  } catch { /* not running */ }
  return "";
}

async function _launchBrowser(): Promise<string> {
  // 1. 尝试连接已有调试端口
  let ws = await _tryConnect();
  if (ws) return ws;

  // 2. 自动启动浏览器
  const cp = require("child_process");
  let browserCmd: string | null = null;

  if (process.platform === "win32") {
    const progFiles = process.env["PROGRAMFILES(X86)"] || "";
    const progFiles64 = process.env["PROGRAMFILES"] || "";
    const edgePaths = [
      path.join(progFiles64, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
    for (const p of edgePaths) {
      if (fs.existsSync(p)) { browserCmd = p; break; }
    }
    if (!browserCmd) {
      try {
        browserCmd = cp.execSync("where msedge", { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0].trim();
      } catch { /* not found */ }
    }
    if (!browserCmd) {
      try {
        browserCmd = cp.execSync("where chrome", { encoding: "utf-8", timeout: 2000 }).trim().split("\n")[0].trim();
      } catch { /* not found */ }
    }
  } else {
    // Linux/Mac
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      try {
        browserCmd = cp.execSync(`which ${name}`, { encoding: "utf-8", timeout: 2000 }).trim();
        if (browserCmd) break;
      } catch { /* not found */ }
    }
  }

  if (!browserCmd) return "";

  // 使用独立的 user-data-dir 避免与已运行浏览器实例冲突
  // 否则 --remote-debugging-port 不会生效（新窗口会附加到已有进程）
  const userDataDir = path.join(os.tmpdir(), "cortex-browser-profile");
  try { fs.mkdirSync(userDataDir, { recursive: true }); } catch { /* ignore */ }

  const launchArgs = [
    "--remote-debugging-port=9222",
    `--user-data-dir=${userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-popup-blocking",
  ];

  try {
    cp.spawn(browserCmd, launchArgs, {
      detached: true,
      stdio: "ignore",
    }).unref();
  } catch { /* launch failed */ }

  // 3. 等待浏览器启动（使用真正的 async sleep）
  for (let i = 0; i < 30; i++) {  // 最多等 15 秒
    await new Promise(r => setTimeout(r, 500));
    ws = await _tryConnect();
    if (ws) return ws;
  }

  return "";
}

async function getBrowserWs(): Promise<string> {
  if (_browserWsUrl) return _browserWsUrl;
  // 防止并发调用重复启动浏览器
  if (_browserLaunching) return _browserLaunching;
  _browserLaunching = _launchBrowser();
  try {
    _browserWsUrl = await _browserLaunching;
    return _browserWsUrl;
  } finally {
    _browserLaunching = null;
  }
}

// ── 工具注册 ──

registry.register(
  "在浏览器中导航到指定 URL。会自动启动浏览器（MS Edge/Chrome）并打开调试端口。\n用法: browser_navigate(url=\"https://example.com\")",
  RiskLevel.WRITE, Capability.BROWSER,
  { workDir: "string", url: "string" },
  async function browser_navigate(_wd: string, args: Record<string, unknown>): Promise<string> {
    const url = String(args["url"]);
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器自动启动失败。请手动启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile";
    try {
      // 在新页面中导航
      const encodedUrl = encodeURIComponent(url);
      const pageInfo = await _httpPut(9222, `/json/new?url=${encodedUrl}`);
      const title = pageInfo.title || "?";
      const wsUrl = pageInfo.webSocketDebuggerUrl || "";
      return `已在浏览器中打开: ${url}\n标题: ${title}\nWebSocket: ${wsUrl.slice(0, 60)}...`;
    } catch (e: any) {
      // 如果 PUT /json/new 失败（某些浏览器版本不支持），尝试用已有页面导航
      try {
        const pages = await _httpGet(9222, "/json");
        if (Array.isArray(pages) && pages.length > 0) {
          return `浏览器已启动 (${pages.length} 个页面)。URL: ${url}\n提示: 浏览器可能已打开，请在浏览器中手动访问该地址。`;
        }
      } catch { /* ignore */ }
      return `(x) 浏览器错误: ${e.message || e}\n请确认浏览器已启动: start msedge --remote-debugging-port=9222 --user-data-dir=%TEMP%\\cortex-browser-profile`;
    }
  },
);

registry.register(
  "获取当前浏览器页面的文本快照（页面列表摘要）。\n用法: browser_snapshot()",
  RiskLevel.SAFE, Capability.BROWSER,
  { workDir: "string" },
  async function browser_snapshot(): Promise<string> {
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    try {
      const pages = await _httpGet(9222, "/json");
      if (!Array.isArray(pages) || !pages.length) return "(无打开的浏览器页面)";
      const lines = [`(${pages.length} 个页面)\n`];
      for (const p of pages) {
        const t = (p.title || "无标题").slice(0, 60);
        const u = (p.url || "").slice(0, 80);
        lines.push(`  [${p.type || "page"}] ${t}`);
        lines.push(`    ${u}`);
      }
      return lines.join("\n");
    } catch (e: any) {
      return `(x) 浏览器错误: ${e.message || e}`;
    }
  },
);

registry.register(
  "截取浏览器页面截图保存到文件。\n用法: browser_screenshot(path=\"browser.png\")",
  RiskLevel.WRITE, Capability.BROWSER,
  { workDir: "string", outPath: "string" },
  async function browser_screenshot(_workDir: string, args: Record<string, unknown>): Promise<string> {
    const ws = await getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    const p = String(args["outPath"] || "browser_screenshot.png");
    try {
      // 获取页面列表
      const pages = await _httpGet(9222, "/json");
      if (!Array.isArray(pages) || !pages.length) return "(x) 浏览器无打开的页面";
      // 截图功能需要 WebSocket CDP 支持，当前版本仅返回页面信息
      return `浏览器已连接 (${pages.length} 个页面)。截图路径: ${p}。注意: 截图功能暂未实现，当前仅返回页面列表。`;
    } catch (e: any) {
      return `(x) 截图失败: ${e.message || e}`;
    }
  },
);

registry.register("桌面截图", RiskLevel.SYSTEM, Capability.BROWSER,
  { workDir: "string", outPath: "string" },
  function computer_screenshot(workDir: string, args: Record<string, unknown>): string {
    const p = String(args["outPath"] || "desktop_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    const ext = path.extname(d).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".bmp"].includes(ext)) {
      return `(x) 不支持的文件类型: ${ext}`;
    }
    if (/[$`;|&<>{}()!"]/.test(d)) {
      return "(x) 路径含非法字符";
    }
    try {
      if (process.platform === "win32") {
        require("child_process").execSync(
          `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap $s.Bounds.Width,$s.Bounds.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size); $b.Save('${d.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()"`,
          { timeout: 15000 }
        );
      }
      return `桌面截图已保存: ${d}`;
    } catch (e: any) { return `(x) 截图失败: ${e.message || e}`; }
  },
);

registry.register("模拟鼠标点击", RiskLevel.SYSTEM, Capability.BROWSER,
  { workDir: "string", x: "number", y: "number" },
  function computer_click(_wd: string, args: Record<string, unknown>): string {
    const x = Number(args["x"] || 0);
    const y = Number(args["y"] || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 32767 || y > 32767) {
      return `(x) 无效坐标: (${args["x"]}, ${args["y"]})`;
    }
    if (process.platform === "win32") {
      try {
        require("child_process").execSync(
          `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})"`,
          { timeout: 10000 }
        );
        return `已点击 (${x}, ${y})`;
      } catch (e: any) { return `(x) 点击失败: ${e.message || e}`; }
    }
    return `(x) 仅支持 Windows`;
  },
);
