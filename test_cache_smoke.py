# -*- coding: utf-8 -*-
"""缓存稳定性冒烟测试：验证 append-only govern + 预算驱动 compact + 缓存统计口径。"""
import sys, json, types
from pathlib import Path

# 测试环境无 httpx/openai 依赖：打桩（本测试不实例化 LLMProvider，仅需模块可导入）
for name in ("httpx", "openai"):
    if name not in sys.modules:
        stub = types.ModuleType(name)
        stub.Timeout = object
        stub.OpenAI = object
        sys.modules[name] = stub

sys.path.insert(0, str(Path(__file__).parent / "python"))

from cortex_agent.cortex_agent import ContextGovernor

PASS, FAIL = "✅", "❌"
failures = []

def check(name, cond, detail=""):
    print(f"  {PASS if cond else FAIL} {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)

print("== 1. govern 零触碰（append-only 前缀稳定）==")
gov = ContextGovernor(system="SYS", work_dir="/tmp/wd",
                      context_limit=1_000_000, max_input_tokens=1_000_000, max_tokens=8192)
ctx = [{"role": "system", "content": "SYS"}]
prev_ser = None
stable = True
# 模拟 40 步 agentic loop：每步 assistant(tool_calls) + 2 条 tool result
for step in range(40):
    ctx.append({"role": "assistant", "content": f"thinking {step}", "tool_calls": [
        {"id": f"tc{step}a", "type": "function", "function": {"name": "read_file", "arguments": "{}"}},
        {"id": f"tc{step}b", "type": "function", "function": {"name": "exec_command", "arguments": "{}"}},
    ]})
    ctx.append({"role": "tool", "tool_call_id": f"tc{step}a", "content": f"result A {step} " + "x" * 100})
    ctx.append({"role": "tool", "tool_call_id": f"tc{step}b", "content": f"result B {step} " + "y" * 2000})
    out = gov.govern(ctx)
    ser = [json.dumps(m, ensure_ascii=False, sort_keys=True) for m in out]
    if prev_ser is not None:
        # 前缀稳定性：上一步的全部消息必须逐字节出现在当前前缀中
        if ser[:len(prev_ser)] != prev_ser:
            stable = False
            diff = next(i for i, (a, b) in enumerate(zip(prev_ser, ser)) if a != b)
            print(f"    ⚠ 步骤 {step} 前缀在 index {diff} 处分叉")
            break
    prev_ser = ser
check("40 步 govern 后历史前缀逐字节稳定", stable)

print("== 2. govern 返回同一对象（无复制/变异）==")
ctx2 = [{"role": "system", "content": "SYS"}, {"role": "user", "content": "hi"}]
check("低于预算时 govern 原样返回", gov.govern(ctx2) is ctx2)

print("== 3. 预算驱动 compact（超额才压缩，且只压一次）==")
gov_small = ContextGovernor(system="SYS", context_limit=100_000,
                            max_input_tokens=10_000, max_tokens=8192,
                            compact_input_pct=50)  # 5000 token 触发
big_ctx = [{"role": "system", "content": "SYS"}]
for i in range(30):
    big_ctx.append({"role": "user", "content": "问题 " * 200})
    big_ctx.append({"role": "assistant", "content": "回答 " * 400})
before = ContextGovernor.estimate_tokens(big_ctx)
out = gov_small.govern(big_ctx)
after = ContextGovernor.estimate_tokens(out)
check("超预算时触发 compact", len(out) < len(big_ctx), f"{len(big_ctx)}→{len(out)} 条, ~{before}→~{after} tok")
check("compact 后保留 system 在首位", out[0]["role"] == "system")

print("== 4. finalize_tool_result 写入时定长（确定性）==")
long_result = "R" * 5000
t1 = gov.finalize_tool_result(long_result)
t2 = gov.finalize_tool_result(long_result)
check("同一输入两次压缩结果一致", t1 == t2)
check("长结果被压缩到阈值内", len(t1) <= gov.compress_threshold + 80, f"{len(long_result)}→{len(t1)} chars")
check("短结果原样保留", gov.finalize_tool_result("short") == "short")

print("== 5. _fix_tool_pairing 只在 compact 边界运行（govern 不再每步调用）==")
# 构造正常 append-only 序列，govern 不应改动任何消息
seq = [{"role": "system", "content": "S"},
       {"role": "assistant", "content": "", "tool_calls": [
           {"id": "a", "type": "function", "function": {"name": "t", "arguments": "{}"}}]},
       {"role": "tool", "tool_call_id": "a", "content": "ok"}]
out = gov.govern(seq)
check("正常配对序列 govern 零改动", out == seq)

print()
if failures:
    print(f"❌ {len(failures)} 项失败: {failures}")
    sys.exit(1)
print("✅ ContextGovernor 全部通过")
