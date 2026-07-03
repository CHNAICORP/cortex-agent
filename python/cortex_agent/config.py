"""
配置加载器 — 从 settings.json 读取配置，合并到 AgentConfig

加载优先级（从低到高）:
  1. 代码默认值 (AgentConfig dataclass defaults)
  2. settings.json（项目级: {cwd}/.cortex/settings.json）
  3. settings.json（用户级: ~/.cortex/settings.json）
  4. 环境变量 (CORTEX_API_KEY, CORTEX_MODEL, etc.)
  5. CLI 参数

settings.json 结构:
{
  "model": "flash",
  "provider": "deepseek",
  "providers": {
    "deepseek": {
      "api_key": "sk-...",
      "base_url": "https://api.deepseek.com/v1",
      "models": { "flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro" }
    },
    "openai": {
      "api_key": "sk-...",
      "base_url": "https://api.openai.com/v1",
      "models": { "gpt4": "gpt-4o", "gpt4m": "gpt-4o-mini" }
    }
  },
  "max_steps": 50,
  "work_dir": "./cortex_workspace",
  "loop_timeout": 600,
  "think_timeout": 300,
  "max_rounds": 0,
  "checkpoint_interval": 5,
  "retry_max": 3,
  "retry_base_delay": 2,
  "compact_threshold": 60,
  "auto_extract_memory": true,
  "memory_enabled": true,
  "sessions_enabled": true
}
"""

import os, json
from typing import Optional


def _smart_merge(base: dict, override: dict):
    """智能合并：override 中的非空值覆盖 base，空值不覆盖。
    
    注意: 0 和 False 是有效值，不应被视为"空"。
    只有 None 和空字符串/空列表/空字典才跳过。
    """
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _smart_merge(base[k], v)
        elif v is None or v == "" or v == [] or v == {}:
            continue  # 空值不覆盖
        else:
            base[k] = v


def _find_upwards(filename: str, start: str = None) -> Optional[str]:
    """从 start 向上搜索 filename，返回完整路径或 None。"""
    d = os.path.abspath(start or os.getcwd())
    while True:
        candidate = os.path.join(d, filename)
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def load_settings(project_dir: str = None) -> dict:
    """加载合并后的设置字典。用户级覆盖项目级。"""
    merged = {}

    # 1. 项目级
    proj = _find_upwards(".cortx/settings.json", project_dir or os.getcwd())
    if proj:
        try:
            with open(proj, "r", encoding="utf-8") as f:
                merged.update(json.load(f))
        except Exception:
            pass

    # 2. 用户级 (~) — 智能合并：非空值覆盖，空值不覆盖
    user = os.path.join(os.path.expanduser("~"), ".cortx", "settings.json")
    if os.path.isfile(user):
        try:
            with open(user, "r", encoding="utf-8") as f:
                user_settings = json.load(f)
            _smart_merge(merged, user_settings)
        except Exception:
            pass

    # 4. 首次运行：如果没有任何配置，自动创建全局模板
    if not merged and not os.environ.get("CORTEX_API_KEY"):
        os.makedirs(os.path.dirname(user), exist_ok=True)
        template = {
            "model": "pro",
            "provider": "deepseek",
            "providers": {
                "deepseek": {
                    "api_key": "",
                    "base_url": "https://api.deepseek.com/v1",
                    "models": {"flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro"}
                },
        "glm": {
            "api_key": "",
            "base_url": "https://open.bigmodel.cn/api/paas/v4",
            "models": {}
        }
            },
            "max_steps": 10,
            "context_limit": 0,
            "max_tokens": 0,
            "max_input_tokens": 0,
            # ── ContextGovernor 可调参数 ──
            "compress_threshold": 1500,
            "compress_head": 600,
            "compress_tail": 400,
            "safety_margin": 4096,
            "input_warn_pct": 80,
            "input_force_pct": 90,
            # ── ToolExecutor 可调参数 ──
            "max_result_chars": 2000,
            # ── Memory 注入控制 ──
            "memory_inject_count": 30,
            "permission_mode": "standard",
            "auto_extract_memory": True,
            "memory_enabled": True,
            "sessions_enabled": True,
        }
        with open(user, "w", encoding="utf-8") as f:
            json.dump(template, f, ensure_ascii=False, indent=2)
        print(f"\n  📝 首次运行: 已创建全局配置 {user}")
        print(f"  ⚙️  请在 providers.deepseek.api_key 填入你的 API Key")
        print(f"  📖 同时也支持项目级配置: .cortex/settings.json\n")
        merged.update(template)

    # 3. 环境变量覆盖
    if os.environ.get("CORTEX_API_KEY"):
        merged.setdefault("providers", {})
        provider = merged.get("provider", "deepseek")
        merged["providers"].setdefault(provider, {})
        merged["providers"][provider]["api_key"] = os.environ["CORTEX_API_KEY"]
    if os.environ.get("CORTEX_MODEL"):
        merged["model"] = os.environ["CORTEX_MODEL"]

    return merged


def apply_to_config(config, settings: dict):
    """将 settings dict 应用到 AgentConfig 对象。"""
    from .cortex_agent import LLMProvider

    # Provider 注册
    LLMProvider.setup(
        providers=settings.get("providers"),
        active=settings.get("provider", "deepseek"),
    )

    # API key：先取当前 provider 的 api_key，再取 settings 顶层，再取 config 已有值
    active_provider = LLMProvider.provider_name()
    providers = settings.get("providers", {})
    provider_cfg = providers.get(active_provider, {})
    api_key = provider_cfg.get("api_key", "") or settings.get("api_key", "") or config.api_key
    config.api_key = api_key

    # 简单字段
    for key in ("model", "max_steps", "tool_timeout", "system_prompt",
                "max_context_msgs", "loop_timeout", "think_timeout",
                "work_dir", "memory_dir", "sessions_dir", "skills_dir",
                "memory_enabled", "sessions_enabled", "auto_extract_memory",
                "permission_mode", "permission_remember", "workspace_only",
                "context_limit", "max_tokens", "max_input_tokens",
                "compress_threshold", "compress_head", "compress_tail",
                "safety_margin", "input_warn_pct", "input_force_pct",
                "max_result_chars", "memory_inject_count",
                "max_rounds", "checkpoint_interval", "retry_max",
                "retry_base_delay", "compact_threshold"):
        if key in settings:
            setattr(config, key, settings[key])


def create_default_settings(path: str) -> dict:
    """在 path 路径创建默认 settings.json。返回写入的 dict。"""
    default = {
        "model": "pro",
        "provider": "deepseek",
        "providers": {
            "deepseek": {
                "api_key": "",
                "base_url": "https://api.deepseek.com/v1",
                "models": {"flash": "deepseek-v4-flash", "pro": "deepseek-v4-pro"},
            },
            "glm": {
                "api_key": "",
                "base_url": "https://open.bigmodel.cn/api/paas/v4",
                "models": {},
            },
        },
        "web_search": {
            "provider": "duckduckgo",       # duckduckgo | brave | serpapi | tavily
            "brave_api_key": "",             # Brave Search API key (https://brave.com/search/api/)
            "serpapi_api_key": "",           # SerpAPI key (https://serpapi.com/)
            "tavily_api_key": "",            # Tavily API key (https://tavily.com/)
            "max_results": 5,
            "timeout": 10,
        },
        "max_steps": 50,
        "loop_timeout": 600,
        "think_timeout": 300,
        "max_rounds": 0,
        "checkpoint_interval": 5,
        "retry_max": 3,
        "retry_base_delay": 2,
        "compact_threshold": 60,
        "auto_extract_memory": True,
        "memory_enabled": True,
        "sessions_enabled": True,
        "permission_mode": "standard",
        "permission_remember": True,
        "workspace_only": False,
        "context_limit": 0,
        "max_tokens": 0,
        "max_input_tokens": 0,
        # ── ContextGovernor 可调参数 (0=使用默认值) ──
        "compress_threshold": 1500,
        "compress_head": 600,
        "compress_tail": 400,
        "safety_margin": 4096,
        "input_warn_pct": 80,
        "input_force_pct": 90,
        # ── ToolExecutor 可调参数 ──
        "max_result_chars": 2000,
        # ── Memory 注入控制 ──
        "memory_inject_count": 30,
        "mcpServers": {
            "playwright": {
                "command": "npx",
                "args": ["-y", "@playwright/mcp@latest"],
                "description": "浏览器自动化（Microsoft 官方）"
            },
            "fetch": {
                "command": "python",
                "args": ["-m", "mcp_server_fetch"],
                "description": "HTTP 抓取 + HTML→Markdown"
            },
            "sqlite": {
                "command": "npx",
                "args": ["-y", "@modelcontextprotocol/server-sqlite"],
                "description": "SQLite 数据库查询"
            },
            "context7": {
                "url": "https://mcp.context7.com/mcp",
                "description": "实时库/框架文档查询"
            }
        }
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    
    # 写入纯净的 settings.json（去除注释）
    clean_default = {k: v for k, v in default.items()}
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean_default, f, ensure_ascii=False, indent=2)
    
    # 写入带注释的 settings.example.jsonc 作为文档
    example_path = path.replace(".json", ".example.jsonc")
    example_content = '''{
  // ── 模型配置 ──
  "model": "pro",                            // 使用的模型别名（见 providers.<provider>.models）
  "provider": "deepseek",                    // 当前激活的提供商
  "providers": {
    "deepseek": {
      "api_key": "",                          // 填入你的 DeepSeek API key
      "base_url": "https://api.deepseek.com/v1",
      "models": {
        "flash": "deepseek-v4-flash",         // 快速模型（适合简单任务）
        "pro": "deepseek-v4-pro"              // 强力模型（适合复杂任务）
      }
    },
    "glm": {
      "api_key": "",                          // 填入你的智谱 AI API key
      "base_url": "https://open.bigmodel.cn/api/paas/v4",
      "models": {}
    }
  },
  "web_search": {
    "provider": "duckduckgo",                 // duckduckgo | brave | serpapi | tavily
    "brave_api_key": "",                      // Brave Search API key
    "serpapi_api_key": "",                    // SerpAPI key
    "tavily_api_key": "",                     // Tavily API key
    "max_results": 5,                         // 搜索结果数量
    "timeout": 10                             // 搜索超时（秒）
  },
  
  // ── Agentic Loop 控制 ──
  "max_steps": 50,                            // 单轮最大思考-行动步数
  "max_rounds": 0,                            // 最大轮数（0=无限制，用于 --long 模式）
  "checkpoint_interval": 5,                  // 每 N 步保存一次断点
  "retry_max": 3,                             // 工具调用失败重试次数
  "retry_base_delay": 2,                      // 重试基础延迟（秒）
  "compact_threshold": 60,                   // 上下文压缩阈值（token 数）
  "loop_timeout": 600,                        // 单轮超时（秒）
  "think_timeout": 300,                       // LLM 思考超时（秒）
  
  // ── 权限模式 ──
  "permission_mode": "standard",              // standard | auto | yolo
  "permission_remember": true,                // 记住用户确认的权限（本次会话）
  "workspace_only": false,                    // 严格限制工作区外操作
  
  // ── 内存/会话 ──
  "memory_enabled": true,                     // 启用长期记忆
  "auto_extract_memory": true,                // 自动从对话中提取记忆
  "sessions_enabled": true,                   // 启用会话管理
  "memory_inject_count": 30,                  // 注入到上下文的记忆条目数
  
  // ── 上下文控制 ──
  "context_limit": 0,                         // 0=自动计算（安全余量+safety_margin）
  "max_tokens": 0,                            // 0=使用模型默认值
  "max_input_tokens": 0,                      // 0=自动计算
  "compress_threshold": 1500,                 // 消息数量阈值，超过则压缩
  "compress_head": 600,                       // 压缩时保留的头部消息数
  "compress_tail": 400,                       // 压缩时保留的尾部消息数
  "safety_margin": 4096,                      // 输入 Token 安全余量
  "input_warn_pct": 80,                       // 超过此百分比发出警告
  "input_force_pct": 90,                      // 超过此百分比强制压缩
  
  // ── 工具执行 ──
  "max_result_chars": 2000,                   // 工具输出最大字符数（超过截断）
  "tool_timeout": 0,                          // 0=不设置超时
  
  // ── MCP 服务器配置 ──
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "description": "浏览器自动化（Microsoft 官方）"
    },
    "fetch": {
      "command": "python",
      "args": ["-m", "mcp_server_fetch"],
      "description": "HTTP 抓取 + HTML→Markdown"
    },
    "sqlite": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-sqlite"],
      "description": "SQLite 数据库查询"
    },
    "context7": {
      "url": "https://mcp.context7.com/mcp",
      "description": "实时库/框架文档查询"
    }
  }
}
'''
    with open(example_path, "w", encoding="utf-8") as f:
        f.write(example_content)
    
    return default
