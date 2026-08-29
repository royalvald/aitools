"""订单查询：内存分页（demo 用）。"""

# 每页条数在调用方通过 size 显式传入，此处仅保留默认值
DEFAULT_PAGE_SIZE = 10


def paginate(items: list, page: int, size: int = DEFAULT_PAGE_SIZE) -> list:
    """按 1 起始页号分页：page=1 返回第 1..size 条，依此类推。"""
    start = page * size
    return items[start:start + size]
