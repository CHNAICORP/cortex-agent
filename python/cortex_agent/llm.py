"""
Cortex Agent LLM Provider — 多 Provider 支持
══════════════════════════════════════════════

支持 DeepSeek / OpenAI / GLM（智谱），流式 + 非流式调用。
模型别名解析 + base_url 配置 + provider 感知的 thinking 参数。
"""

import json, time, httpx
from openai import OpenAI
from typing import List, Dict, Callable, Optional, Tuple


# ══════════════════════════════════════════════════════════════
# LLM Provider
# ══════════════════════════════════════════════════════════════

class LLMProvider:
    # 默认提供者注册表：settings.json 中 providers 段可覆盖
    DEFAULT_PROVIDERS = {
        "deepseek": {
            "name": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "models": {
                "flash": "deepseek-v4-flash",
                "pro":   "deepseek-v4-pro",
            },
        },
        "openai": {
            "name": "openai",
            "base_url": "https://api.openai.com/v1",
            "models": {},
        },
        "glm": {
            "name": "glm",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "models": {},  # 无别名 — glm-5.2 / glm-5.2-flash 直接作为模型名使用
        },
    }

    # ── Model Capabilities Registry ──
    # 每个模型的实际上下文窗口和最大输出 token 数。
    # context_limit=0 或 max_tokens=0 时自动从此注册表解析。
    MODEL_CAPABILITIES = {
        # DeepSeek V4 系列 — 1M 上下文窗口
        "deepseek-v4-flash":  {"context_window": 1_000_000, "max_output_tokens": 8192},
        "deepseek-v4-pro":   {"context_window": 1_000_000, "max_output_tokens": 8192},
        # GLM 系列 — 1M 上下文窗口
        "glm-5.2":            {"context_window": 1_000_000, "max_output_tokens": 4096},
        "glm-5.2-flash":     {"context_window": 1_000_000, "max_output_tokens": 4096},
        # OpenAI 系列
        "gpt-4o":             {"context_window": 128_000,   "max_output_tokens": 16384},
        "gpt-4o-mini":        {"context_window": 128_000,   "max_output_tokens": 16384},
    }
    # 按前缀匹配的默认能力（用于未注册的模型名）
    _PREFIX_DEFAULTS = [
        ("deepseek",  {"context_window": 1_000_000, "max_output_tokens": 8192}),
        ("glm",       {"context_window": 1_000_000, "max_output_tokens": 4096}),
        ("gpt-4",     {"context_window": 128_000,   "max_output_tokens": 16384}),
        ("gpt-3.5",   {"context_window": 16_000,    "max_output_tokens": 4096}),
    ]
    # 全局回退默认值
    _FALLBACK_CAPS = {"context_window": 128_000, "max_output_tokens": 8192}
    # 当前激活的提供者（首次使用前由 AgentConfig.setup_providers 初始化）
    _active = None
    _provider_name = None

    @classmethod
    def setup(cls, providers: dict = None, active: str = None):
        """从 settings.json 注册 provider 列表，并设置当前使用的 provider。
        providers 结构: { name: { base_url, api_key?, models: { alias: model_id } } }
        """
        if providers:
            for name, cfg in providers.items():
                cls.DEFAULT_PROVIDERS[name] = {
                    "name": name,
                    "base_url": cfg.get("base_url", ""),
                    "models": dict(cfg.get("models", {})),
                }
        cls._provider_name = active or "deepseek"
        cls._active = cls.DEFAULT_PROVIDERS.get(cls._provider_name, cls.DEFAULT_PROVIDERS["deepseek"])

    @classmethod
    def resolve(cls, name: str) -> str:
        """将别名解析为真实 model id。先查当前 provider 的 models 映射，再查全局。"""
        active = cls._active or cls.DEFAULT_PROVIDERS.get("deepseek", {})
        models = active.get("models", {})
        if name in models:
            return models[name]
        # 回退：跨 provider 查找
        for p in cls.DEFAULT_PROVIDERS.values():
            if name in p.get("models", {}):
                return p["models"][name]
        return name  # 按原始值传递（可能是完整 model id）

    @classmethod
    def base_url(cls) -> str:
        active = cls._active or cls.DEFAULT_PROVIDERS.get("deepseek", {})
        return active.get("base_url", "https://api.deepseek.com/v1")

    @classmethod
    def provider_name(cls) -> str:
        return cls._provider_name or "deepseek"

    @classmethod
    def resolve_capabilities(cls, model: str) -> dict:
        """解析模型的上下文窗口和最大输出 token 数。
        
        查找顺序:
          1. MODEL_CAPABILITIES 精确匹配
          2. _PREFIX_DEFAULTS 前缀匹配
          3. _FALLBACK_CAPS 回退默认值
        
        返回: {"context_window": int, "max_output_tokens": int}
        """
        model_lower = model.lower().strip()
        # 1. 精确匹配
        if model_lower in cls.MODEL_CAPABILITIES:
            return cls.MODEL_CAPABILITIES[model_lower]
        # 2. 前缀匹配
        for prefix, caps in cls._PREFIX_DEFAULTS:
            if model_lower.startswith(prefix):
                return caps
        # 3. 回退
        return cls._FALLBACK_CAPS

    def __init__(self, api_key: str, model: str, tools: List[Dict],
                 timeout: float = 60.0, max_tokens: int = 8192):
        self.client = OpenAI(api_key=api_key, base_url=self.base_url(),
                             timeout=httpx.Timeout(timeout, connect=10.0))
        self.model = model; self.tools = tools
        self.max_tokens = max_tokens
        # ── 缓存命中率追踪 ──
        self._call_count: int = 0
        self._cache_hits: int = 0
        self._total_input_tokens: int = 0
        self._total_cached_tokens: int = 0

    @property
    def cache_stats(self) -> dict:
        """返回缓存统计信息。"""
        rate = (self._cache_hits / self._call_count * 100) if self._call_count > 0 else 0
        return {
            "calls": self._call_count,
            "cache_hits": self._cache_hits,
            "hit_rate": rate,
            "total_input_tokens": self._total_input_tokens,
            "total_cached_tokens": self._total_cached_tokens,
        }

    def _track_usage(self, resp):
        """从 API 响应中提取 usage 信息更新缓存统计。"""
        try:
            usage = getattr(resp, 'usage', None)
            if usage:
                self._call_count += 1
                self._total_input_tokens += getattr(usage, 'prompt_tokens', 0) or 0
                cached = getattr(usage, 'prompt_tokens_details', None)
                if cached:
                    ct = getattr(cached, 'cached_tokens', 0) or 0
                    self._total_cached_tokens += ct
                    if ct > 0:
                        self._cache_hits += 1
        except Exception:
            self._call_count += 1  # 至少计数

    def switch(self, alias: str): self.model = self.resolve(alias)

    def _thinking_kwargs(self, thinking: bool) -> dict:
        """根据当前 provider 生成 thinking 参数。
        
        GLM 使用 thinking_budget 控制推理强度，DeepSeek/OpenAI 使用 reasoning_effort。
        """
        if not thinking:
            return {}
        provider = self.provider_name()
        if provider == "glm":
            # GLM-5.2: thinking.type + thinking_budget
            return {"extra_body": {"thinking": {"type": "enabled", "thinking_budget": "max"}}}
        # DeepSeek / OpenAI / default
        return {"extra_body": {"thinking": {"type": "enabled"}}, "reasoning_effort": "max"}

    def call(self, messages: List[Dict], thinking: bool = True
             ) -> Tuple[str, Optional[List[Dict]], Optional[str], str]:
        """非流式调用。返回 (text, tool_calls, reasoning, finish_reason)。
        
        thinking=False 时关闭推理模式，用于空响应恢复——确保 LLM 将全部
        max_tokens 预算用于 content/tool_calls 而非 reasoning。
        """
        kwargs: Dict = {
            "model": self.model, "messages": messages,
            "tools": self.tools, "max_tokens": self.max_tokens,
        }
        kwargs.update(self._thinking_kwargs(thinking))
        resp = self.client.chat.completions.create(**kwargs)
        self._track_usage(resp)
        choice = resp.choices[0]
        msg = choice.message
        text = msg.content or ""
        reasoning = getattr(msg, 'reasoning_content', None) or None
        finish_reason = choice.finish_reason or ""
        tcs = None
        if msg.tool_calls:
            tcs = [{"id": tc.id, "name": tc.function.name,
                    "args": json.loads(tc.function.arguments) if tc.function.arguments else {}}
                   for tc in msg.tool_calls]
        return text, tcs, reasoning, finish_reason

    def call_stream(self, messages: List[Dict],
                    on_text: Callable[[str], None] = None,
                    on_answer: Callable[[str], None] = None,
                    on_tool: Callable[[str, dict], None] = None,
                    thinking: bool = True
                    ) -> Tuple[str, Optional[List[Dict]], str, str]:
        """流式调用：返回 (text, tool_calls, reasoning_text, finish_reason)。
        
        thinking=False 时关闭推理模式，用于空响应恢复。
        """
        kwargs: Dict = {
            "model": self.model, "messages": messages,
            "tools": self.tools, "max_tokens": self.max_tokens,
            "stream": True,
        }
        kwargs.update(self._thinking_kwargs(thinking))
        resp = self.client.chat.completions.create(**kwargs)
        reasoning_parts, text_parts = [], []
        tool_buf: Dict[int, dict] = {}
        reasoning_done = False
        tool_seen = False
        finish_reason = ""
        for chunk in resp:
            choice = chunk.choices[0] if chunk.choices else None
            if choice and choice.finish_reason:
                finish_reason = choice.finish_reason
            delta = choice.delta if choice else None
            if not delta: continue
            if getattr(delta, 'reasoning_content', None):
                reasoning_parts.append(delta.reasoning_content)
                if on_text: on_text(delta.reasoning_content)        # thinking tokens → deep grey
            if delta.content:
                if on_answer and not reasoning_done:
                    on_answer("")  # signal: flush reasoning, switch to bright
                    reasoning_done = True
                text_parts.append(delta.content)
                if on_answer: on_answer(delta.content)               # answer tokens → bright
            if delta.tool_calls:
                if not tool_seen and on_tool:
                    on_tool("", {})  # sentinel: close reasoning before tool labels
                    tool_seen = True
                for tcd in delta.tool_calls:
                    idx = tcd.index
                    if idx not in tool_buf:
                        tool_buf[idx] = {"id": tcd.id or "", "name": "", "args_json": ""}
                    if tcd.id: tool_buf[idx]["id"] = tcd.id
                    if tcd.function:
                        if tcd.function.name: tool_buf[idx]["name"] += tcd.function.name
                        if tcd.function.arguments: tool_buf[idx]["args_json"] += tcd.function.arguments
        text = "".join(text_parts); reasoning = "".join(reasoning_parts)
        tcs = None
        if tool_buf:
            tcs = []
            for idx in sorted(tool_buf.keys()):
                tb = tool_buf[idx]
                try: args = json.loads(tb["args_json"])
                except json.JSONDecodeError: args = {}
                tcs.append({"id": tb["id"], "name": tb["name"], "args": args})
        # 流式调用：至少计数 + 估算 token
        self._call_count += 1
        total_chars = sum(len(m.get("content", "") or "") for m in messages)
        self._total_input_tokens += int(total_chars * 0.4)
        return text, tcs, reasoning, finish_reason

