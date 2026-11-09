
from datetime import datetime, timedelta, timezone

import numpy as np


def evaluate_storm(
    history,
    threshold_mm,
    dry_required=6,
    max_age_hours=8,
    now=None
):
    """Reconstruct storm state from retained IMERG history.

    Returns the latest reconstructed storm state.
    Freshness is reported separately.
    """

    now = now or datetime.now(timezone.utc)

    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")

    if threshold_mm is None:
        return {
            "storm_active": False,
            "consecutive_dry_observations": 0,
            "observations_evaluated": 0,
            "data_fresh": False,
            "reason": "threshold_not_configured"
        }

    if not np.isfinite(threshold_mm) or threshold_mm <= 0:
        raise ValueError("Threshold must be positive and finite")

    if dry_required < 1:
        raise ValueError("dry_required must be positive")

    observations = []

    for timestamp, rainfall in history.items():
        ts = datetime.fromisoformat(timestamp)

        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        else:
            ts = ts.astimezone(timezone.utc)

        if ts > now:
            continue

        arr = np.asarray(rainfall, dtype=np.float32)

        maximum = (
            float(np.nanmax(arr))
            if np.isfinite(arr).any()
            else None
        )

        observations.append((ts, maximum))

    observations.sort(key=lambda item: item[0])

    active = False
    dry_count = 0
    previous = None

    for ts, maximum in observations:
        consecutive = (
            previous is not None
            and ts - previous == timedelta(minutes=30)
        )

        if not consecutive:
            dry_count = 0

        previous = ts

        if maximum is None:
            dry_count = 0
            continue

        if maximum >= threshold_mm:
            active = True
            dry_count = 0

        elif active:
            if consecutive:
                dry_count += 1
            else:
                dry_count = 1

            if dry_count >= dry_required:
                active = False
                dry_count = 0

    latest = observations[-1][0] if observations else None

    age_hours = (
        (now - latest - timedelta(minutes=30)).total_seconds()
        / 3600
        if latest is not None
        else None
    )

    fresh = (
        age_hours is not None
        and -0.5 <= age_hours <= max_age_hours
    )

    return {
        "storm_active": active,
        "consecutive_dry_observations": dry_count,
        "observations_evaluated": len(observations),
        "data_fresh": fresh,
        "latest_observation_utc":
            latest.isoformat() if latest else None,
        "reason": "reconstructed_from_history"
    }
