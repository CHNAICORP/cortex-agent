# Cortex Agent — Harness Agent 架构 + Agentic Loop 运行时

## 设计哲学

**Harness Agent** 是一套安全可控的 AI Agent 运行时框架。
核心原则：

1. **Agent 自主决策** — Harness 提供工具和安全边界，Agent 自行思考如何解决问题。
   Harness **不注入行为指令**——不告诉 Agent "你应该先 X 再 Y"、"信息足够了停止搜索"。
   Agent 从工具结果中自主推理，自行判断何时收敛、何时换策略。

2. **完整中介** — 所有工具调用必须经过 PolicyEngine 审计，每条工具结果如实返回。
   安全违规以工具错误形式呈现（如 `(x) [Policy 拦截] ...`），Agent 自行解读并调整。

3. **Share-nothing 隔离** — 每个 Agent 实例持有独立的 work_dir / executor / observer。

4. **结构性约束** — 步数上限、超时等机制是 Harness 的结构性边界，不是以自然语言注入的指令。

## Agentic Loop

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Think   │ →  │  Guard   │ →  │   Act    │ →  │ Reflect  │
│ (LLM流式)│    │(Policy)  │    │(Executor)│    │(步数收敛)│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
       ↑                                              │
       └──────────────────────────────────────────────┘
```

## 项目结构（每文件 ≤ 800 行）

```
cortex_agent.py   (580行) — 核心引擎：Agentic Loop / AgentConfig / Observer / ContextGovernor / ToolRegistry / ToolExecutor
policy.py         (215行) — 安全策略引擎：PolicyEngine（4 级判决 + SSRF/SQL/Shell/Python 检测）
llm.py            (146行) — LLM Provider：DeepSeek / OpenAI 流式+非流式调用
tools.py          (555行) — 核心工具：文件/搜索/DB/Shell/Python/网络/记忆/任务/辅助
tools_mcp.py      (180行) — MCP 客户端：mcp_list_servers / mcp_list_tools / mcp_call_tool
tools_browser.py  (257行) — 浏览器自动化：CDP WebSocket 直连（零依赖）
tools_computer.py  (86行) — 桌面控制：截图 / 鼠标点击
tools_network.py  (227行) — 网络工具：HTTP 代理 / pip npm 镜像源切换
main.py           (252行) — CLI 入口：REPL 交互 / 会话管理 / 命令路由
terminal.py       (145行) — 终端显示：thinking/answer 差异化染色 + 长思考折叠
memory.py         (234行) — 持久化：MemoryStore 单文件 + SessionStore JSONL
config.py         (140行) — 配置加载：多层优先级合并
cortex_workspace/         — 默认工作目录（自动创建）
```

## 38 个工具（按模块）

| 模块 | 工具 | Capability |
|------|------|-----------|
| **tools.py** | `list_directory` `read_file` `write_file` `edit_file` `glob` `grep` `execute_sql_query` `run_shell_command` `run_python` `get_current_time` `web_search` `web_fetch` `remember_fact` `recall_fact` `forget_fact` `ask_user` `python_lint` `task_create` `task_list` `task_update` `diff_files` `http_request` `file_ops` `read_json` `csv_query` | FS / DB / SHELL / NET |
| **tools_mcp.py** | `mcp_list_servers` `mcp_list_tools` `mcp_call_tool` | SHELL / FS |
| **tools_browser.py** | `browser_navigate` `browser_snapshot` `browser_screenshot` | NET_HTTP |
| **tools_computer.py** | `computer_screenshot` `computer_click` | SHELL |
| **tools_network.py** | `set_proxy` `unset_proxy` `show_proxy` `pip_mirror` `npm_mirror` | FS_WRITE / SAFE |

## 安全机制

- **完整中介**: 所有工具调用必经 `PolicyEngine.audit()`（在 `policy.py` 中）
- **SSRF 防护**: 10 段 CIDR 内网 IP 拦截
- **SQL 注入防护**: 词边界正则 + 仅 SELECT + 多语句禁止
- **Python 沙箱**: 子进程隔离 + builtins 清洗
- **路径穿越防护**: 工作目录归一化 + 越权检测
- **自适应熔断**: 同一 capability 连续 3 次违规 → 自动暂停
- **Agent 原生时间感知**: `get_current_time` 工具
- **share-nothing 实例隔离**: 多 Agent 并行不串扰

## 用法

```bash
python main.py                          # 交互 REPL（默认 flash 模型）
python main.py --model pro              # 使用 Pro 模型（强推理）
python main.py --work-dir ./my_ws       # 指定工作目录
python main.py -q "search for Python"   # 单次查询
python main.py --no-stream              # 关闭流式输出
python main.py --mode yolo              # 全部放行模式
```

## 库使用

```python
from main import create_agent
from terminal import Terminal

agent = create_agent(model="pro", work_dir="./my_ws", term=Terminal(enabled=False))
agent.run("write a fibonacci function in Python")
```
