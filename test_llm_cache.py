# -*- coding: utf-8 -*-
"""llm.py 缓存相关纯函数测试：usage 提取口径 + Anthropic cache_control 断点。"""
import sys, types
from pathlib import Path

for name in ("httpx", "openai"):
    if name not in sys.modules:
        stub = types.ModuleType(name)
        stub.Timeout = object
        stub.OpenAI = object
        sys.modules[name] = stub

sys.path.insert(0, str(Path(__file__).parent / "python"))
from cortex_agent.llm import LLMProvider

PASS, FAIL = "✅", "❌"
failures = []

def check(name, cond, detail=""):
    print(f"  {PASS if cond else FAIL} {name}" + (f" — {detail}" if detail else ""))
    if not cond:
        failures.append(name)

# 绕过 __init__（需要真实 OpenAI client），构造裸实例
p = LLMProvider.__new__(LLMProvider)
p.tools = [
    {"type": "function", "function": {"name": "read_file", "description": "d", "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {"name": "exec_command", "description": "d", "parameters": {"type": "object", "properties": {}}}},
]

print("== 1. 各 provider 缓存 usage 字段提取 ==")
class Obj:  # 模拟 openai SDK 返回的对象属性访问
    def __init__(self, **kw): self.__dict__.update(kw)

check("OpenAI 嵌套字段", LLMProvider._extract_cached_tokens(
    Obj(prompt_tokens=1000, prompt_tokens_details=Obj(cached_tokens=896))) == 896)
check("DeepSeek 顶层字段", LLMProvider._extract_cached_tokens(
    Obj(prompt_tokens=1000, prompt_cache_hit_tokens=768, prompt_cache_miss_tokens=232)) == 768)
check("GLM 顶层兼容字段", LLMProvider._extract_cached_tokens(
    Obj(prompt_tokens=1000, cached_tokens=512)) == 512)
check("dict 形式（流式 JSON）", LLMProvider._extract_cached_tokens(
    {"prompt_tokens": 1000, "prompt_cache_hit_tokens": 640}) == 640)
check("无缓存字段返回 0", LLMProvider._extract_cached_tokens(Obj(prompt_tokens=1000)) == 0)
check("None 返回 0", LLMProvider._extract_cached_tokens(None) == 0)

print("== 2. Anthropic cache_control 断点 ==")
tools = p._convert_tools_to_anthropic()
check("最后一个 tool 带 ephemeral 断点", tools[-1].get("cache_control", {}).get("type") == "ephemeral")
check("其余 tool 不带断点", all("cache_control" not in t for t in tools[:-1]))

print("== 3. 尾部移动断点 ==")
msgs_str = [{"role": "user", "content": "hello"}]
p._mark_tail_breakpoint(msgs_str)
check("字符串 content → 带断点的 block", msgs_str[0]["content"][0]["cache_control"]["type"] == "ephemeral")

msgs_blocks = [{"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "x", "content": "r1"},
    {"type": "tool_result", "tool_use_id": "y", "content": "r2"},
]}]
p._mark_tail_breakpoint(msgs_blocks)
check("block 列表 → 仅最后一个 block 带断点",
      "cache_control" not in msgs_blocks[0]["content"][0]
      and msgs_blocks[0]["content"][-1]["cache_control"]["type"] == "ephemeral")

p._mark_tail_breakpoint([])
check("空列表安全", True)

print("== 4. TTL 配置 ==")
LLMProvider.ANTHROPIC_CACHE_TTL = None
check("默认 5m（无 ttl 键）", "ttl" not in LLMProvider._cache_control())
LLMProvider.ANTHROPIC_CACHE_TTL = "1h"
check("1h TTL 生效", LLMProvider._cache_control().get("ttl") == "1h")
LLMProvider.ANTHROPIC_CACHE_TTL = None

print()
if failures:
    print(f"❌ {len(failures)} 项失败: {failures}")
    sys.exit(1)
print("✅ llm.py 全部通过")
