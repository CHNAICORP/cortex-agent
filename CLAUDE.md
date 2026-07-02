# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical Rule: Dual-Language Sync

**Python and TypeScript are two independent implementations that must stay in sync.** Every change to one must be ported to the other.

| Layer | Python | TypeScript |
|-------|--------|------------|
| Agentic Loop engine | `python/cortex_agent/cortex_agent.py` | `src/core/loop.ts` |
| Tool registry + schema gen | `cortex_agent.py` → `ToolRegistry` class | `src/core/registry.ts` |
| PolicyEngine (security auditor) | `python/cortex_agent/policy.py` | `src/core/policy.ts` |
| LLM provider | `python/cortex_agent/llm.py` | `src/core/llm.ts` |
| Tool implementations (25 core) | `python/cortex_agent/tools.py` | `src/tools/file.ts` + `src/tools/exec.ts` |
| Web search + fetch | `tools.py` → `web_search` / `web_fetch` | `src/tools/net.ts` |
| Memory + sessions | `python/cortex_agent/memory.py` | `src/tools/memory.ts` |
| MCP client + 15-server registry | `python/cortex_agent/tools_mcp.py` | `src/tools/mcp.ts` + `src/tools/proxy.ts` |
| Browser automation (CDP) | `python/cortex_agent/tools_browser.py` | `src/tools/browser.ts` |
| Proxy/mirrors/RAG | `python/cortex_agent/tools_network.py` + `tools_rag.py` | `src/tools/proxy.ts` |
| CLI + REPL | `python/cortex_agent/main.py` | `src/cli/main.ts` |
| Config loader (settings.json) | `python/cortex_agent/config.py` | `src/config.ts` |
| Skills system | `python/cortex_agent/skills.py` | (not yet in TS) |
| Core types/enums | `cortex_agent.py` → `RiskLevel`/`Capability`/etc. | `src/core/types.ts` |

### Development workflow

```
1. Make changes to Python code
2. Port the same changes to TypeScript code (or vice versa)
3. Build & Test both locally:
   npx tsc --outDir dist          # TypeScript — must compile with 0 errors
   python -c "import sys;sys.path.insert(0,'python');import cortex_agent.tools"  # Python — must import clean
4. Run agent end-to-end tests (use --mode auto-edit):
   # Python
   python -c "import sys;sys.path.insert(0,'python');from cortex_agent.main import main;..." -q "test query"
   # TypeScript (requires proxy if behind firewall)
   ctx --no-stream --mode auto-edit -q "test query"
5. When both pass → version bump → git commit + tag → publish
```

### Version bump checklist

Update these **4 files in lockstep**:

- `pyproject.toml` → `project.version`
- `python/cortex_agent/__init__.py` → `__version__`
- `package.json` → `version`
- Run `npx tsc --outDir dist` before npm publish (auto-run via `prepublishOnly`)

### Publish

```bash
# Python
python -m build --wheel
twine upload dist/cortx-<version>-py3-none-any.whl

# TypeScript
npm publish --access public

# Git
git add -A && git commit -m "🔖 vX.Y.Z — <summary>" && git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin main --tags
```

## Architecture: Harness Agent

The repo contains **two independent implementations** of the same agent runtime — Python and TypeScript — sharing identical design but no shared code.

### Agentic Loop (4-phase, same in both)

```
Think (LLM streaming with reasoning) → Guard (PolicyEngine audit) → Act (ToolExecutor) → Reflect (step limit / convergence)
```

The LLM receives all 43 tool schemas as `tools` parameter. It autonomously picks which tool to call based on descriptions. The harness never injects behavioral instructions — it only provides tools and enforces safety boundaries.

### Tool registration pattern

Both languages use the same decorator pattern:

```python
# Python
@registry.register("description", risk=RiskLevel.SAFE, capability=Capability.NET_SEARCH)
def web_search(work_dir: str, query: str) -> str: ...

# TypeScript
registry.register("description", RiskLevel.SAFE, Capability.NET_SEARCH,
  { workDir: "string", query: "string" },
  function web_search(workDir: string, args: Record<string, unknown>): string { ... });
```

The registry auto-generates OpenAI function-calling schemas from parameter type hints (Python `get_type_hints`, TS `paramTypes` dict).

### Configuration loading (3-tier merge)

1. Project-level: `<cwd>/.cortex/settings.json`
2. User-level: `~/.cortex/settings.json` (smart merge — non-empty values overwrite)
3. Environment: `CORTEX_API_KEY`, `CORTEX_MODEL`

`settings.json` supports `providers` (multiple LLM backends), `web_search` (search engine selection + API keys), and `mcpServers`.

### Web search: multi-engine architecture

`web_search` has a config-driven provider chain in `settings.json`:

```json
{ "web_search": { "provider": "duckduckgo", "brave_api_key": "", "serpapi_api_key": "", "tavily_api_key": "" } }
```

Priority: configured provider → DuckDuckGo API → DuckDuckGo Lite HTML scrape → "(未找到结果)"

All HTTP calls use a proxy-aware opener (`_build_opener()` in Python, `httpRequest()` in TS) that reads `HTTPS_PROXY`/`HTTP_PROXY` env vars.

### Permission model (3 modes)

| Mode | SAFE tools | WRITE tools | SYSTEM tools |
|------|-----------|-------------|--------------|
| `standard` | auto-allow | within-workspace auto-allow, outside confirm | confirm |
| `auto-edit` | auto-allow | auto-allow (even outside) | auto-allow |
| `yolo` | auto-allow | auto-allow | auto-allow |

CONFIRM verdicts in non-interactive (`--no-stream`) standard mode auto-deny. In yolo/auto-edit, they auto-allow. `_request_confirmation()` in Python prompts `[Y/n/always/deny]` interactively.

### PolicyEngine: always-content-audit

Content audit (SQL injection, shell dangerous commands, Python sandbox escape, path traversal, SSRF) runs **even when the permission mode would otherwise auto-allow**. A dangerous command is always blocked. The verdict chain is:

```
meta lookup → content audit (hard block if fails) → permission mode verdict → YOLO bypass
```

### SSRF protection

10 CIDR ranges blocked in both implementations: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `0.0.0.0/8`, `224.0.0.0/4`, `::1/128`, `fc00::/7`, `fe80::/10`. Python uses `ipaddress` module; TS uses manual CIDR bit math.

### Adaptive guard

Any capability that gets 3 consecutive denials in a single session is suspended for the remainder of that session. `agent.reset()` clears all suspensions.
