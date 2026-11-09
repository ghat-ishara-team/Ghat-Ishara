
"""Offline tests for GHAT ISHARA cloud controller.

Tests the actual storm and scheduling decision statements
from cloud_controller.py.

Run:
    python IMERG_Live/test_controller_decisions.py

No NASA login, network requests, state-file writes,
or rainfall pipeline execution.
"""

import ast
import os

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import numpy as np

from storm_logic import evaluate_storm


# --------------------------------------------------
# TEST CONFIGURATION
# --------------------------------------------------

CONTROLLER = Path(__file__).with_name(
    "cloud_controller.py"
)

NOW = datetime(
    2026, 11, 9, 12, 0,
    tzinfo=timezone.utc
)

TODAY = "2026-11-09"


# --------------------------------------------------
# EXTRACT ACTUAL CONTROLLER DECISION LOGIC
# --------------------------------------------------

def decision_statements():

    tree = ast.parse(
        CONTROLLER.read_text(encoding="utf-8")
    )

    run = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef)
        and node.name == "run"
    )

    begin = next(
        i
        for i, node in enumerate(run.body)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name)
            and target.id == "dry_required"
            for target in node.targets
        )
    )

    end = next(
        i
        for i, node in enumerate(run.body)
        if isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name)
            and target.id == "due"
            for target in node.targets
        )
    )

    module = ast.fix_missing_locations(
        ast.Module(
            body=run.body[begin:end + 1],
            type_ignores=[]
        )
    )

    return compile(
        module,
        str(CONTROLLER),
        "exec"
    )


BLOCK = decision_statements()


# --------------------------------------------------
# CREATE SYNTHETIC RAINFALL HISTORY
# --------------------------------------------------

def make_history(
    values,
    hours_ago=4,
    missing=()
):

    start = NOW - timedelta(
        hours=hours_ago
    )

    return {
        (
            start + timedelta(minutes=30 * i)
        ).isoformat(): np.array(
            [[value]],
            dtype=np.float32
        )

        for i, value in enumerate(values)
        if i not in missing
    }


# --------------------------------------------------
# TEST HELPER
# --------------------------------------------------

def check(
    name,
    history,
    *,
    previous=False,
    pending=False,
    retry=False,
    last_run=TODAY,
    threshold=10.0,
    season=False,
    fresh=True,
    new_obs=(),
    expected_active=False,
    expected_mode="nonmonsoon_daily",
    expected_due=False,
    expected_uncertain=False,
    expected_reset=None
):

    state = {
        "storm_active": previous,
        "pending_full_processing": pending,
        "full_pipeline_retry_pending": retry,
        "last_full_run_local_date": last_run,
    }

    env = {
        "history": history,
        "rain_threshold": threshold,
        "MAX_AGE_HOURS": 8,
        "now": NOW,
        "state": state,
        "fresh": fresh,
        "new_obs": list(new_obs),
        "today": TODAY,
        "evaluate_storm": evaluate_storm,
        "monsoon": lambda now: season,
        "datetime": datetime,
        "timedelta": timedelta,
        "timezone": timezone,
        "np": np,
        "os": os,
    }

    with patch.dict(
        os.environ,
        {"DRY_OBSERVATIONS_TO_RESET": "6"}
    ):
        exec(BLOCK, env)

    actual = (
        env["active"],
        env["mode"],
        bool(env["due"]),
        state["storm_state_uncertain"],
        env["verified_dry_reset"]
    )

    expected = (
        expected_active,
        expected_mode,
        expected_due,
        expected_uncertain,
        expected_reset
    )

    # Always verify the first four scheduling decisions.
    assert actual[:4] == expected[:4], (
        f"{name} failed:\n"
        f"Expected: {expected[:4]}\n"
        f"Actual:   {actual[:4]}"
    )

    # Verify dry-streak detection when explicitly requested.
    if expected_reset is not None:

        assert actual[4] == expected_reset, (
            f"{name} failed: dry reset mismatch\n"
            f"Expected: {expected_reset}\n"
            f"Actual:   {actual[4]}"
        )

    print(f"PASS: {name}")


# --------------------------------------------------
# CONTROLLER DECISION TESTS
# --------------------------------------------------

if __name__ == "__main__":

    # TEST 1
    # Dry nonmonsoon weather should remain in daily mode.

    check(
        "Dry nonmonsoon remains daily",
        make_history([0] * 8),
        expected_reset=True
    )

    # TEST 2
    # Heavy rainfall activates storm monitoring.

    check(
        "Heavy rain activates storm and processes pending work",
        make_history([0, 0, 12, 0, 0, 0, 0, 0]),
        pending=True,
        expected_active=True,
        expected_mode="storm_30min",
        expected_due=True
    )

    # TEST 3
    # Chronological replay includes late-arriving rainfall.

    check(
        "Late heavy granule included in chronological replay",
        make_history([0, 0, 0, 12, 0, 0, 0, 0]),
        expected_active=True,
        expected_mode="storm_30min"
    )

    # TEST 4
    # Six consecutive dry observations reset a storm.

    check(
        "Six dry observations clear previous storm",
        make_history([12] + [0] * 6),
        previous=True,
        expected_reset=True
    )

    # TEST 5
    # A previously active storm is preserved when
    # insufficient dry observations are available.

    check(
        "Previous storm remains uncertain without verified dry reset",
        make_history([0, 0, 0]),
        previous=True,
        expected_active=True,
        expected_mode="storm_30min",
        expected_uncertain=True,
        expected_reset=False
    )

    # TEST 6
    # Stale observations must not newly activate storm mode.

    check(
        "Stale history cannot newly activate storm",
        make_history(
            [12, 0, 0],
            hours_ago=12
        ),
        fresh=False,
        expected_uncertain=True
    )

    # TEST 7
    # An existing storm with stale observations
    # remains active but uncertain.

    check(
        "Stale existing storm stays flagged uncertain",
        make_history(
            [12, 0, 0],
            hours_ago=12
        ),
        previous=True,
        fresh=False,
        expected_active=True,
        expected_mode="storm_30min",
        expected_uncertain=True
    )

    # TEST 8
    # The daily full pipeline runs if it has
    # not run on the current date.

    check(
        "Daily pipeline still runs when due",
        make_history([0] * 8),
        last_run="2026-11-08",
        expected_due=True,
        expected_reset=True
    )

    # TEST 9
    # A failed pipeline must retry even during
    # dry nonmonsoon conditions.

    check(
        "Retry remains due in dry nonmonsoon",
        make_history([0] * 8),
        retry=True,
        expected_due=True,
        expected_reset=True
    )

    # TEST 10
    # Monsoon monitoring processes pending work.

    check(
        "Monsoon pending work runs",
        make_history([0] * 8),
        season=True,
        pending=True,
        expected_mode="monsoon_30min",
        expected_due=True,
        expected_reset=True
    )

    # TEST 11
    # New observations trigger full processing
    # when storm mode is active.

    check(
        "New observations mark work pending in storm mode",
        make_history([12, 0, 0]),
        new_obs=[("placeholder", 12)],
        expected_active=True,
        expected_mode="storm_30min",
        expected_due=True
    )

    # TEST 12
    # Without a configured rainfall threshold,
    # preserve the daily nonmonsoon mode.

    check(
        "Unconfigured threshold preserves daily mode",
        make_history([12, 0, 0]),
        threshold=None,
        previous=True,
        expected_active=False,
        expected_mode="nonmonsoon_daily",
        expected_due=False
    )

    print(
        "\nAll 12 offline controller decision tests passed."
    )
