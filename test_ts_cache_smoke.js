// TS 版缓存稳定性冒烟测试：验证编译产物 dist/ 的 append-only govern 行为
const { ContextGovernor } = require("./dist/core/loop.js");

let failures = 0;
function check(name, cond, detail = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

console.log("== 1. govern 零触碰（append-only 前缀稳定）==");
const gov = new ContextGovernor({
  system: "SYS", workDir: "/tmp/wd",
  contextLimit: 1_000_000, maxInputTokens: 1_000_000, maxTokens: 8192,
});
const ctx = [{ role: "system", content: "SYS" }];
let prevSer = null;
let stable = true;
for (let step = 0; step < 40; step++) {
  ctx.push({ role: "assistant", content: `thinking ${step}`, tool_calls: [
    { id: `tc${step}a`, type: "function", function: { name: "read_file", arguments: "{}" } },
    { id: `tc${step}b`, type: "function", function: { name: "exec_command", arguments: "{}" } },
  ]});
  ctx.push({ role: "tool", tool_call_id: `tc${step}a`, content: `result A ${step} ` + "x".repeat(100) });
  ctx.push({ role: "tool", tool_call_id: `tc${step}b`, content: `result B ${step} ` + "y".repeat(2000) });
  const out = gov.govern(ctx);
  const ser = out.map(m => JSON.stringify(m));
  if (prevSer !== null) {
    const prefixOk = prevSer.every((s, i) => ser[i] === s);
    if (!prefixOk) { stable = false; console.log(`    ⚠ 步骤 ${step} 前缀分叉`); break; }
  }
  prevSer = ser;
}
check("40 步 govern 后历史前缀逐字节稳定", stable);

console.log("== 2. 低于预算时原样返回 ==");
const ctx2 = [{ role: "system", content: "SYS" }, { role: "user", content: "hi" }];
check("govern 返回同一引用（零触碰）", gov.govern(ctx2) === ctx2);

console.log("== 3. 预算驱动 compact ==");
const govSmall = new ContextGovernor({
  system: "SYS", contextLimit: 100_000, maxInputTokens: 10_000,
  maxTokens: 8192, compactInputPct: 50,
});
const bigCtx = [{ role: "system", content: "SYS" }];
for (let i = 0; i < 30; i++) {
  bigCtx.push({ role: "user", content: "问题 ".repeat(200) });
  bigCtx.push({ role: "assistant", content: "回答 ".repeat(400) });
}
const out = govSmall.govern(bigCtx);
check("超预算时触发 compact", out.length < bigCtx.length, `${bigCtx.length}→${out.length} 条`);
check("compact 后保留 system 在首位", out[0].role === "system");

console.log("== 4. finalizeToolResult 写入时定长 ==");
const long = "R".repeat(5000);
const t1 = gov.finalizeToolResult(long);
check("确定性压缩", t1 === gov.finalizeToolResult(long));
check("压到阈值内", t1.length <= gov.compressThreshold + 80, `5000→${t1.length}`);
check("短结果原样", gov.finalizeToolResult("short") === "short");

console.log("== 5. LLMProvider.extractCachedTokens 口径 ==");
const { LLMProvider } = require("./dist/core/llm.js");
check("OpenAI 嵌套", LLMProvider.extractCachedTokens({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 896 } }) === 896);
check("DeepSeek 顶层", LLMProvider.extractCachedTokens({ prompt_tokens: 1000, prompt_cache_hit_tokens: 768 }) === 768);
check("GLM 顶层兼容", LLMProvider.extractCachedTokens({ prompt_tokens: 1000, cached_tokens: 512 }) === 512);
check("无字段/空值", LLMProvider.extractCachedTokens({ prompt_tokens: 1 }) === 0 && LLMProvider.extractCachedTokens(null) === 0);

console.log();
if (failures > 0) { console.log(`❌ ${failures} 项失败`); process.exit(1); }
console.log("✅ TS 编译产物全部通过");
