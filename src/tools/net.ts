/**
 * 网络工具 — web_search + web_fetch
 */
import { registry } from "../core/registry";
import { RiskLevel, Capability } from "../core/types";

registry.register(
  "联网搜索网页",
  RiskLevel.SAFE, Capability.NET_SEARCH,
  { workDir: "string", query: "string" },
  async function web_search(workDir: string, args: Record<string, unknown>): Promise<string> {
    const query = String(args["query"]);
    try {
      const url = `https://lite.duckduckgo.com/lite/`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (compatible; CortexAgent/1.0)",
        },
        body: new URLSearchParams({ q: query }).toString(),
      });
      const html = await resp.text();
      const results: string[] = [];
      const linkRe = /<a[^>]*rel=["']nofollow["'][^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
      let m;
      let count = 0;
      while ((m = linkRe.exec(html)) !== null && count < 5) {
        const u = m[1];
        const title = m[2].replace(/<[^>]+>/g, "").trim();
        if (!title || u.includes("duckduckgo.com")) continue;
        results.push(`[${count + 1}] ${title}\n    URL: ${u}`);
        count++;
      }
      if (!results.length) return "(未找到结果)";
      return `搜索 "${query}" (${results.length} 条):\n\n${results.join("\n\n")}`;
    } catch (e) {
      return `(x) 搜索失败: ${e}`;
    }
  },
);
