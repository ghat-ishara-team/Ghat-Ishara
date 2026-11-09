
from datetime import datetime, timedelta, timezone
import numpy as np

from storm_logic import evaluate_storm

now = datetime(2026, 11, 9, 12, 0, tzinfo=timezone.utc)


def make_history(values, start_hours_ago=4):
    history = {}
    start = now - timedelta(hours=start_hours_ago)

    for i, value in enumerate(values):
        ts = start + timedelta(minutes=30 * i)
        history[ts.isoformat()] = np.array(
            [[value]], dtype=np.float32
        )

    return history


def check(name, history, expected):
    result = evaluate_storm(
        history,
        threshold_mm=10.0,
        dry_required=6,
        now=now
    )

    assert result["storm_active"] == expected, (
        f"{name} failed: {result}"
    )

    print(f"PASS: {name} -> {result}")


# Test 1: Heavy rainfall followed by four dry observations
check(
    "Storm remains active",
    make_history([0, 0, 0, 12, 0, 0, 0, 0]),
    True
)

# Test 2: Six consecutive dry observations reset storm
check(
    "Six dry observations reset storm",
    make_history([12, 0, 0, 0, 0, 0, 0]),
    False
)

# Test 3: Late-arriving heavy rainfall
history = make_history([0, 0, 0, 0, 0, 0, 0, 0])
timestamps = sorted(history)

# Replace an older observation with heavy rainfall
history[timestamps[4]] = np.array(
    [[15.0]], dtype=np.float32
)

check(
    "Late-arriving heavy observation",
    history,
    True
)

# Test 4: Missing interval breaks consecutive dry streak
history = make_history([12, 0, 0, 0, 0, 0, 0])
timestamps = sorted(history)

del history[timestamps[3]]

check(
    "Missing interval prevents dry reset",
    history,
    True
)


# Test 5: A storm followed by 16 consecutive
# dry observations must deactivate.
history = make_history(
    [12] + [0] * 16,
    start_hours_ago=10
)

check(
    "Old storm correctly resets after dry weather",
    history,
    False
)

# Test 6: Heavy rainfall occurred before the
# eight-hour lookback, but fewer than six
# consecutive dry observations followed.

history = make_history(
    [12, 0, 0, 0, 0],
    start_hours_ago=9
)

check(
    "Storm persists across lookback boundary",
    history,
    True
)

# Test 7: A missing heavy-rainfall observation arrives
# after newer dry observations were already stored.

history = make_history([0, 0, 0, 0, 0, 0, 0, 0])
timestamps = sorted(history)

before = evaluate_storm(
    history,
    threshold_mm=10.0,
    now=now
)

assert before["storm_active"] is False

# Simulate a delayed heavy observation replacing
# a previously missing timestamp.
del history[timestamps[4]]

history[timestamps[4]] = np.array(
    [[15.0]], dtype=np.float32
)

after = evaluate_storm(
    history,
    threshold_mm=10.0,
    now=now
)

assert after["storm_active"] is True
print("PASS: Incremental late arrival")


# Test 8: Old observations must be marked stale.

old_history = make_history(
    [12, 0, 0],
    start_hours_ago=12
)

result = evaluate_storm(
    old_history,
    threshold_mm=10.0,
    max_age_hours=8,
    now=now
)

assert result["data_fresh"] is False
print("PASS: Stale observations identified")


# Test 9: No rainfall observations.

result = evaluate_storm(
    {},
    threshold_mm=10.0,
    now=now
)

assert result["storm_active"] is False
assert result["data_fresh"] is False

print("PASS: Empty history")

print("\nAll tests completed.")
