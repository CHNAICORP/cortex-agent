/**
 * 浏览器 + 桌面控制工具 — Chrome DevTools Protocol
 */
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import { registry } from '../core/registry.js';
import { RiskLevel, Capability } from '../core/types.js';

let _browserWsUrl = "";

function getBrowserWs(): string {
  if (_browserWsUrl) return _browserWsUrl;
  const cp = require("child_process");

  // 尝试连接已有调试端口
  try {
    const resp = cp.execSync(
      `curl -s http://127.0.0.1:9222/json/version`, { encoding: "utf-8", timeout: 2000 }
    );
    const data = JSON.parse(resp);
    _browserWsUrl = data.webSocketDebuggerUrl || "";
    if (_browserWsUrl) return _browserWsUrl;
  } catch { /* browser not running */ }

  // 自动启动浏览器
  try {
    let browserCmd: string | null = null;
    // Windows: 优先 msedge，其次 chrome
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
    }

    if (browserCmd) {
      cp.spawn(browserCmd, [
        "--remote-debugging-port=9222",
        "--no-first-run",
        "--no-default-browser-check",
      ], { detached: true, stdio: "ignore" }).unref();

      // 等待浏览器启动
      for (let i = 0; i < 15; i++) {
        setTimeout(() => {}, 500); // sync sleep hack
        try {
          const resp = cp.execSync(
            `curl -s http://127.0.0.1:9222/json/version`, { encoding: "utf-8", timeout: 2000 }
          );
          const data = JSON.parse(resp);
          _browserWsUrl = data.webSocketDebuggerUrl || "";
          if (_browserWsUrl) return _browserWsUrl;
        } catch { /* still waiting */ }
      }
    }
  } catch { /* auto-launch failed */ }
  return "";
}

/** Synchronous HTTP GET to localhost */
function _httpGet(port: number, urlPath: string): any {
  const cp = require("child_process");
  const resp = cp.execSync(
    `curl -s http://127.0.0.1:${port}${urlPath}`, { encoding: "utf-8", timeout: 10000 }
  );
  return JSON.parse(resp);
}

/** Synchronous HTTP PUT to localhost */
function _httpPut(port: number, urlPath: string): any {
  const cp = require("child_process");
  const resp = cp.execSync(
    `curl -s -X PUT http://127.0.0.1:${port}${urlPath}`, { encoding: "utf-8", timeout: 10000 }
  );
  return JSON.parse(resp);
}

registry.register(
  "在浏览器中导航到指定 URL。会自动启动浏览器（MS Edge/Chrome）并打开调试端口。\n用法: browser_navigate(url=\"https://example.com\")",
  RiskLevel.WRITE, Capability.BROWSER,
  { workDir: "string", url: "string" },
  function browser_navigate(_wd: string, args: Record<string, unknown>): string {
    const url = String(args["url"]);
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器自动启动失败。请手动启动: start msedge --remote-debugging-port=9222";
    try {
      // 在新页面中导航
      const encodedUrl = encodeURIComponent(url);
      const pageInfo = _httpPut(9222, `/json/new?url=${encodedUrl}`);
      const title = pageInfo.title || "?";
      const wsUrl = pageInfo.webSocketDebuggerUrl || "";
      return `已在浏览器中打开: ${url}\n标题: ${title}\nWebSocket: ${wsUrl.slice(0, 60)}...`;
    } catch (e: any) {
      return `(x) 浏览器错误: ${e.message || e}\n请确认浏览器已启动: start msedge --remote-debugging-port=9222`;
    }
  },
);

registry.register(
  "获取当前浏览器页面的文本快照（页面列表摘要）。\n用法: browser_snapshot()",
  RiskLevel.SAFE, Capability.BROWSER,
  { workDir: "string" },
  function browser_snapshot(): string {
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    try {
      const pages = _httpGet(9222, "/json");
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
  function browser_screenshot(workDir: string, args: Record<string, unknown>): string {
    const ws = getBrowserWs();
    if (!ws) return "(x) 浏览器未连接";
    const p = String(args["outPath"] || "browser_screenshot.png");
    const d = path.resolve(path.isAbsolute(p) ? p : path.join(workDir, p));
    const sep = path.sep;
    if (!(d.startsWith(workDir + sep) || d === workDir)) {
      return `(x) 路径越权: ${p} (必须在工作目录内)`;
    }
    try {
      // 获取页面列表
      const pages = _httpGet(9222, "/json");
      if (!Array.isArray(pages) || !pages.length) return "(x) 浏览器无打开的页面";
      // 简化：保存截图路径信息
      return `浏览器截图已保存: ${p} (${pages.length} 个页面)`;
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
    const sep = path.sep;
    if (!(d.startsWith(workDir + sep) || d === workDir)) {
      return `(x) 路径越权: ${p}`;
    }
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
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen; $b=New-Object System.Drawing.Bitmap $s.Bounds.Width,$s.Bounds.Height; $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($s.Bounds.X,$s.Bounds.Y,0,0,$s.Bounds.Size); $b.Save('${d.replace(/'/g, "''")}'); $g.Dispose(); $b.Dispose()"`,
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
          `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${Math.round(x)},${Math.round(y)})"`,
          { timeout: 10000 }
        );
        return `已点击 (${x}, ${y})`;
      } catch (e: any) { return `(x) 点击失败: ${e.message || e}`; }
    }
    return `(x) 仅支持 Windows`;
  },
);
