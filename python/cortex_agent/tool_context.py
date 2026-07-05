"""
Tool Context — 全局工具上下文

允许工具函数访问 Agent 级别的功能（如用户交互、子代理生成），
而不需要修改工具函数签名。

与 TS tool_context.ts 对应
"""

from typing import Optional, Callable, Any, Dict

_ctx: Dict[str, Any] = {}


def set_tool_context(ctx: Dict[str, Any]) -> None:
    """设置工具上下文"""
    _ctx.update(ctx)


def get_tool_context() -> Dict[str, Any]:
    """获取工具上下文"""
    return _ctx


def clear_tool_context() -> None:
    """清空工具上下文"""
    _ctx.clear()
