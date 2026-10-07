"""熬锅出胶门槛：最近一次煮胶峰值温度须 ≥ 90℃；封灶旗升起时该坊停登峰值。"""

from typing import Optional

from app.models import Kettle, SealFlag

MIN_PEAK = 90.0


class RuleError(ValueError):
    pass


def latest_peak(kettle: Kettle) -> float | None:
    if not kettle.cooks:
        return None
    latest = max(kettle.cooks, key=lambda c: c.taken_at)
    return latest.peak_temp_c


def assert_can_log_peak(seal: Optional[SealFlag]) -> None:
    """登记峰值门槛：该坊封灶旗升起则挡；降下或未建旗不拦。"""
    if seal is not None and seal.raised:
        raise RuleError("封灶旗已升起，该坊暂停登记峰值")


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
