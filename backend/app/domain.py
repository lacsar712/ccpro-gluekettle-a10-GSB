"""熬锅门槛。

- 出胶：最近一次煮胶峰值温度须 ≥ 90℃，与封灶旗无关。
- 登记峰值：坊上封灶旗升起时禁止入库；改锅态不受封灶影响。
"""

from app.models import Kettle

MIN_PEAK = 90.0


class RuleError(ValueError):
    pass


def latest_peak(kettle: Kettle) -> float | None:
    if not kettle.cooks:
        return None
    latest = max(kettle.cooks, key=lambda c: c.taken_at)
    return latest.peak_temp_c


def assert_can_log_peak(seal_raised: bool) -> None:
    if seal_raised:
        raise RuleError("本坊封灶旗已升起，封灶期间不得登记峰值")


def assert_can_set_status(kettle: Kettle, new_status: str) -> None:
    allowed = {Kettle.STATUS_COLD, Kettle.STATUS_BOILING, Kettle.STATUS_DRAWN}
    if new_status not in allowed:
        raise RuleError(f"无效状态：{new_status}")
    if new_status != Kettle.STATUS_DRAWN:
        return
    peak = latest_peak(kettle)
    if peak is None:
        raise RuleError("该锅尚无煮胶峰值，不能出胶")
    if peak < MIN_PEAK:
        raise RuleError(f"最近峰值 {peak}℃ 低于 {MIN_PEAK:.0f}℃，不能出胶")
