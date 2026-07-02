# Cortex Agent

安全可控的 AI Agent 运行时框架 — **Harness Agent 架构 + Agentic Loop 引擎**

[![Python](https://img.shields.io/badge/python-3.10+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Lines](https://img.shields.io/badge/total%20lines-~3,200-orange.svg)]()

Cortex Agent 是一个从零构建的 AI Agent 运行时，零外部 Agent 框架依赖。核心哲学：**给 Agent 工具和安全边界，但不替它思考。**

---

## 设计哲学

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│  Think   │ →  │  Guard   │ →  │   Act    │ →  │ Reflect  │
│ (LLM流式)│    │(Policy)  │    │(Executor)│    │(步数收敛)│
└──────────┘    └──────────┘    └──────────┘    └──────────┘
       ↑                                              │
       └──────────────────────────────────────────────┘
```

| 原则 | 说明 |
|------|------|
| **Agent 自主决策** | 不注入行为指令，Agent 从工具结果中自行推理 |
| **完整中介** | 所有工具调用必经 PolicyEngine 4 级审计 |
| **Share-nothing** | 每实例独立 work_dir / executor / observer |
| **结构性约束** | 步数上限/超时是框架边界，非自然语言注入 |

---

## 快速开始

```bash
# 安装依赖
pip install -r requirements.txt

# 配置 API Key
mkdir -p .cortex
echo '{"model":"pro","provider":"deepseek","providers":{"deepseek":{"api_key":"sk-xxx","base_url":"https://api.deepseek.com/v1","models":{"flash":"deepseek-v4-flash","pro":"deepseek-v4-pro"}}}}' > .cortex/settings.json

# 启动交互 REPL
python main.py

# 单次查询
python main.py -q "用 Python 写斐波那契函数"

# 指定模型
python main.py --model pro
```

---

## 功能矩阵

### 41 个内置工具

| 模块 | 工具数 | 能力域 |
|------|--------|--------|
| `tools.py` | 25 | 文件/SQL/Shell/Python/网络/记忆/任务 |
| `tools_mcp.py` | 6 | MCP 客户端 + 15 个注册表 Server |
| `tools_browser.py` | 3 | Chrome CDP 浏览器自动化 |
| `tools_computer.py` | 2 | 桌面截图/鼠标控制 |
| `tools_network.py` | 5 | HTTP 代理/pip npm 镜像 |

### 交互功能

| 功能 | 快捷键/命令 |
|------|-----------|
| 权限模式切换 | `Shift+Tab` 或 `/mode [s\|a\|y]` |
| 上下文容量 | `[s 0%]>` 提示行 + `/context` |
| 知识库 | `CORTEX.md` 自动注入 + `/kb` |
| 文件引用 | `@filename` 模糊搜索注入 |
| 技能系统 | `/skills` + `/skill <name>` |
| 持久化目标 | `/goal [目标]` |
| 规划模式 | `/plan [描述]` |

---

## 项目结构

```
cortex_agent.py    (580行)  Agentic Loop 核心引擎
policy.py          (215行)  PolicyEngine 安全策略
llm.py             (146行)  LLM Provider (DeepSeek/OpenAI)
tools.py           (555行)  核心工具 (25个)
tools_mcp.py       (180行)  MCP 客户端 + 注册表
tools_browser.py   (257行)  CDP WebSocket 浏览器
tools_computer.py   (86行)  桌面控制
tools_network.py   (227行)  代理/镜像工具
main.py            (252行)  CLI 入口 + REPL
terminal.py        (145行)  流式终端渲染
memory.py          (234行)  记忆/会话持久化
config.py          (140行)  配置加载
skills.py          (180行)  技能系统
```

---

## 权限模式

| 模式 | 行为 | 适用场景 |
|------|------|---------|
| `standard` 🛡️ | SAFE自动/WRITE区内/SYSTEM需确认 | 日常交互 |
| `auto-edit` ✏️ | 自动批准编辑+SYSTEM放行 | 代码生成 |
| `yolo` ⚠️ | 全部放行 | CI/CD 自动化 |

---

## 安全机制

- **SSRF 防护**: 10 段 CIDR + IPv4-mapped IPv6 拦截
- **SQL 注入防护**: 仅 SELECT + 游标级行数限制
- **Python 沙箱**: 子进程隔离 + 16 条逃逸检测
- **路径穿越防护**: 工作目录归一化 + 所有路径参数检测
- **自适应熔断**: 同 capability 3 次违规 → 自动暂停

---

## 库使用

```python
from main import create_agent
from terminal import Terminal

agent = create_agent(model="pro", work_dir="./my_ws", term=Terminal(enabled=False))
agent.run("write a fibonacci function in Python")
```

---

## License

MIT — 详见 [LICENSE](LICENSE)
