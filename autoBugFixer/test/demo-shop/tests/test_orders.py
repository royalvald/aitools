"""订单分页的预期契约（1 起始页号，page=N 返回第 (N-1)*size+1 .. N*size 条）。"""

from demo_shop.orders import paginate


def _items(n: int) -> list:
    return [f"order-{i:03d}" for i in range(1, n + 1)]


def test_first_page_returns_first_ten():
    assert paginate(_items(55), 1) == _items(55)[:10]


def test_second_page_returns_eleventh_to_twentieth():
    assert paginate(_items(55), 2) == _items(55)[10:20]


def test_last_partial_page_not_empty():
    assert paginate(_items(55), 6) == _items(55)[50:55]
