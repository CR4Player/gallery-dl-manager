"""Pure-Python 5-field cron parser, validator, next-run calculator, and Chinese description."""

from __future__ import annotations

from datetime import datetime, timedelta


def _parse_field(expr: str, min_val: int, max_val: int, is_dow: bool = False) -> set[int]:
    result: set[int] = set()
    for part in expr.split(","):
        part = part.strip()
        if not part:
            raise ValueError(f"Empty cron field part in '{expr}'")
        if "/" in part:
            range_str, step_str = part.split("/", 1)
            step = int(step_str)
            if step <= 0:
                raise ValueError(f"Step must be > 0 in '{part}'")
        else:
            range_str, step = part, 1

        if range_str == "*":
            start, end = min_val, max_val
        elif "-" in range_str:
            a, b = range_str.split("-", 1)
            start, end = int(a), int(b)
        else:
            val = int(range_str)
            start, end = val, val

        if start < min_val or end > max_val or start > end:
            raise ValueError(f"Value out of range [{min_val}, {max_val}] in '{part}'")

        for v in range(start, end + 1, step):
            result.add(0 if (is_dow and v == 7) else v)
    return result


def parse_cron(expr: str):
    """Parse standard 5-field cron expression."""
    parts = expr.strip().split()
    if len(parts) != 5:
        raise ValueError(f"Cron 表达式必须包含 5 段 (分 时 日 月 周)，当前为: '{expr}'")
    minutes = _parse_field(parts[0], 0, 59)
    hours = _parse_field(parts[1], 0, 23)
    doms = _parse_field(parts[2], 1, 31)
    months = _parse_field(parts[3], 1, 12)
    dows = _parse_field(parts[4], 0, 7, is_dow=True)
    return minutes, hours, doms, months, dows, parts[2] == "*", parts[4] == "*"


def validate_cron(expr: str) -> str:
    """Normalize and validate cron expression, raising ValueError if invalid."""
    normalized = " ".join(expr.strip().split())
    parse_cron(normalized)
    return normalized


def matches(dt: datetime, spec) -> bool:
    """Check whether datetime matches parsed cron spec."""
    minutes, hours, doms, months, dows, dom_any, dow_any = spec
    if dt.minute not in minutes or dt.hour not in hours or dt.month not in months:
        return False
    # Python weekday(): Mon=0..Sun=6 -> cron: Sun=0, Mon=1..Sat=6
    cron_dow = (dt.weekday() + 1) % 7
    dom_match = dt.day in doms
    dow_match = cron_dow in dows
    if not dom_any and not dow_any:
        return dom_match or dow_match
    return dom_match and dow_match


def next_runs(expr: str, count: int = 3, now: datetime | None = None) -> list[datetime]:
    """Compute the next `count` trigger timestamps in local timezone."""
    spec = parse_cron(expr)
    base = now if now is not None else datetime.now().astimezone()
    cursor = base.replace(second=0, microsecond=0) + timedelta(minutes=1)
    results: list[datetime] = []
    # Scan up to 366 days ahead (527040 minutes)
    limit = 527040
    for _ in range(limit):
        if matches(cursor, spec):
            results.append(cursor)
            if len(results) >= count:
                break
        cursor += timedelta(minutes=1)
    return results


_DOW_NAMES = {
    "0": "周日",
    "1": "周一",
    "2": "周二",
    "3": "周三",
    "4": "周四",
    "5": "周五",
    "6": "周六",
    "7": "周日",
}


def describe_cron_zh(expr: str) -> str:
    """Return a concise Chinese description for a valid 5-field cron expression."""
    normalized = validate_cron(expr)
    m, h, dom, mon, dow = normalized.split()

    if dom == "*" and mon == "*" and dow == "*":
        if m.startswith("*/") and h == "*":
            return f"每 {m[2:]} 分钟执行一次"
        if m.isdigit() and h.startswith("*/"):
            return f"每 {h[2:]} 小时的第 {int(m):02d} 分执行"
        if m == "0" and h == "*":
            return "每小时整点执行"
        if m.isdigit() and h.isdigit():
            return f"每天 {int(h):02d}:{int(m):02d} 执行"
        if m.isdigit() and "," in h and all(x.isdigit() for x in h.split(",")):
            times = "、".join(f"{int(x):02d}:{int(m):02d}" for x in h.split(","))
            return f"每天 {times} 执行"

    if dom == "*" and mon == "*" and dow in _DOW_NAMES and m.isdigit() and h.isdigit():
        return f"每{_DOW_NAMES[dow]} {int(h):02d}:{int(m):02d} 执行"

    if dom.isdigit() and mon == "*" and dow == "*" and m.isdigit() and h.isdigit():
        return f"每月 {int(dom)} 日 {int(h):02d}:{int(m):02d} 执行"

    return f"自定义 Cron：{normalized}"
