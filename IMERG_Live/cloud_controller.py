
"""GHAT ISHARA: adaptive NASA IMERG observed-rainfall monitor.

Persists compact regional rainfall history between cloud executions.
Calculates complete 4h, 24h and 72h observed rainfall accumulations.

This is a monitoring prototype, not a validated landslide warning system.
"""

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import earthaccess
import numpy as np
import xarray as xr

import rainfall_pipeline as pipe


ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "cloud_output"
OUT.mkdir(parents=True, exist_ok=True)

STATE = OUT / "scheduler_state.json"
STATUS = OUT / "latest_status.json"
HISTORY = OUT / "history.npz"

IST = ZoneInfo("Asia/Kolkata")

MAX_AGE_HOURS = 8
HISTORY_HOURS = 74
MAX_PROBE_FILES = 12

# Prevent unexpectedly large history files from being committed.
MAX_HISTORY_BYTES = 25 * 1024 * 1024


def write_json(path, obj):
    temp = path.with_suffix(".tmp")
    temp.write_text(
        json.dumps(obj, indent=2),
        encoding="utf-8"
    )
    temp.replace(path)


def read_state():
    try:
        return json.loads(
            STATE.read_text(encoding="utf-8")
        )
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def monsoon(now):
    start = os.getenv("MONSOON_START", "05-25").strip() or "05-25"
    end = os.getenv("MONSOON_END", "10-05").strip() or "10-05"

    md = now.astimezone(IST).strftime("%m-%d")

    if start <= end:
        return start <= md <= end

    return md >= start or md <= end


def threshold():
    raw = os.getenv(
        "HEAVY_RAIN_30MIN_MM", ""
    ).strip()

    if not raw:
        return None

    result = float(raw)

    if not np.isfinite(result) or result <= 0:
        raise ValueError(
            "HEAVY_RAIN_30MIN_MM must be positive and finite"
        )

    return result


def load_history():
    if not HISTORY.exists():
        return {}, None, None

    with np.load(
        HISTORY, allow_pickle=False
    ) as data:

        stamps = data["timestamps"].astype(str).tolist()
        cubes = data["rain"].astype(np.float32)
        lat = data["lat"].copy()
        lon = data["lon"].copy()

    if len(stamps) != len(cubes):
        raise ValueError(
            "Rainfall history timestamps and grids do not match"
        )

    return dict(zip(stamps, cubes)), lat, lon


def save_history(items, lat, lon, now):
    cutoff = (
        now - timedelta(hours=HISTORY_HOURS)
    ).isoformat()

    items = {
        k: v for k, v in items.items()
        if k >= cutoff
    }

    if not items:
        return items

    stamps = sorted(items)

    temp = HISTORY.with_suffix(".tmp.npz")

    try:
        np.savez_compressed(
            temp,
            timestamps=np.asarray(stamps),
            rain=np.stack([items[s] for s in stamps]),
            lat=lat,
            lon=lon
        )

        size = temp.stat().st_size

        if size > MAX_HISTORY_BYTES:
            raise RuntimeError(
                f"Rainfall history is {size / 1048576:.2f} MiB; "
                f"maximum allowed is "
                f"{MAX_HISTORY_BYTES / 1048576:.2f} MiB. "
                "Move history to object storage before deployment."
            )

        temp.replace(HISTORY)

    finally:
        temp.unlink(missing_ok=True)

    return items


def read_observation(path):
    with xr.open_dataarray(path) as da:

        if (
            da.name != "rainfall_30min"
            or da.attrs.get("units") != "mm"
        ):
            raise ValueError(
                "Unexpected processed rainfall data"
            )

        ts = datetime.fromisoformat(
            da.attrs["observation_start_utc"]
        )

        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        else:
            ts = ts.astimezone(timezone.utc)

        rain = da.values.astype(np.float32).copy()
        lat = da.lat.values.copy()
        lon = da.lon.values.copy()

    if rain.shape != (len(lat), len(lon)):
        raise ValueError(
            "Rainfall grid dimensions do not match coordinates"
        )

    return ts, rain, lat, lon


def update_windows(items, lat, lon, now):
    available = {}

    if not items:
        return available

    latest = datetime.fromisoformat(max(items))

    for name, count in (
        ("4h", 8),
        ("24h", 48),
        ("72h", 144)
    ):

        keys = [
            (
                latest - timedelta(minutes=30 * i)
            ).isoformat()
            for i in range(count - 1, -1, -1)
        ]

        missing = [
            k for k in keys
            if k not in items
        ]

        destination = (
            OUT / f"rainfall_{name}_latest.npz"
        )

        if missing:
            destination.unlink(missing_ok=True)

            available[name] = {
                "complete": False,
                "observations": count - len(missing),
                "required": count,
                "missing": len(missing)
            }
            continue

        cube = np.stack(
            [items[k] for k in keys]
        )

        valid = np.isfinite(cube).all(axis=0)

        total = np.where(
            valid,
            np.nansum(cube, axis=0),
            np.nan
        ).astype(np.float32)

        temp = destination.with_suffix(
            ".tmp.npz"
        )

        try:
            np.savez_compressed(
                temp,
                rain_mm=total,
                lat=lat,
                lon=lon,
                window_start_utc=keys[0],
                window_end_utc=(
                    latest + timedelta(minutes=30)
                ).isoformat()
            )

            temp.replace(destination)

        finally:
            temp.unlink(missing_ok=True)

        maximum = (
            float(np.nanmax(total))
            if np.isfinite(total).any()
            else None
        )

        available[name] = {
            "complete": True,
            "observations": count,
            "required": count,
            "max_mm": maximum
        }

    return available


def prioritize_missing(discovered, history):
    """Prioritize recent observations, then older gaps.

    First recover the newest 4 hours, then the rest of the
    72-hour history, without repeatedly selecting stored files.
    """

    missing = [
        (ts, filename, url)
        for ts, (filename, url) in discovered
        if ts.replace(
            tzinfo=timezone.utc
        ).isoformat() not in history
    ]

    if not missing:
        return []

    latest = discovered[-1][0]
    recent_cutoff = latest - timedelta(hours=4)

    recent = sorted(
        [
            item for item in missing
            if item[0] >= recent_cutoff
        ],
        reverse=True
    )

    older = sorted(
        [
            item for item in missing
            if item[0] < recent_cutoff
        ]
    )

    return recent + older


def run():
    now = datetime.now(timezone.utc)

    state = read_state()
    history, lat, lon = load_history()

    errors = []
    rain_threshold = threshold()

    today = now.astimezone(
        IST
    ).date().isoformat()

    new_obs = []
    discovered = []

    backlog_before = 0
    backlog_processed = 0
    failed_observations = 0

    try:
        auth = earthaccess.login(
            strategy="netrc",
            persist=False
        )

        if not auth.authenticated:
            raise RuntimeError(
                "NASA Earthdata authentication failed"
            )

        session = (
            earthaccess.get_requests_https_session()
        )

        for offset in range(4):
            day = (
                now - timedelta(days=offset)
            ).date()

            discovered.extend(
                pipe.discover_archive_files(
                    session, day
                )
            )

        cutoff = (
            now - timedelta(hours=HISTORY_HOURS)
        ).replace(tzinfo=None)

        discovered = sorted({
            ts: (filename, url)
            for ts, filename, url in discovered
            if cutoff <= ts <= now.replace(
                tzinfo=None
            )
        }.items())

        missing = prioritize_missing(
            discovered, history
        )

        backlog_before = len(missing)

        for ts, filename, url in missing[
            :MAX_PROBE_FILES
        ]:

            try:
                raw = pipe.RAW_DIR / filename

                processed = (
                    pipe.PROCESSED_DIR /
                    (
                        Path(filename).stem
                        + "_rainfall.nc"
                    )
                )

                if not pipe.validate_processed(
                    processed, raw
                ):

                    if not pipe.validate_raw_hdf5(
                        raw
                    ):
                        pipe.download_one_hdf5(
                            session,
                            filename,
                            url
                        )

                    pipe.process_file(raw)

                obs_ts, rain, obs_lat, obs_lon = (
                    read_observation(processed)
                )

                expected_ts = ts.replace(
                    tzinfo=timezone.utc
                )

                if obs_ts != expected_ts:
                    raise RuntimeError(
                        "Processed observation timestamp "
                        "does not match archive timestamp"
                    )

                if lat is not None:
                    if (
                        not np.array_equal(
                            lat, obs_lat
                        )
                        or not np.array_equal(
                            lon, obs_lon
                        )
                    ):
                        raise RuntimeError(
                            "Rainfall grid changed; "
                            "refusing to mix different grids"
                        )

                lat, lon = obs_lat, obs_lon

                history[
                    obs_ts.isoformat()
                ] = rain

                maximum = (
                    float(np.nanmax(rain))
                    if np.isfinite(rain).any()
                    else None
                )

                new_obs.append(
                    (obs_ts, maximum)
                )

                backlog_processed += 1

            except Exception as exc:
                failed_observations += 1

                errors.append(
                    f"observation {filename}: {exc}"
                )

    except Exception as exc:
        errors.append(
            f"monitoring: {exc}"
        )

    if history:
        try:
            history = save_history(
                history, lat, lon, now
            )
        except Exception as exc:
            errors.append(
                f"history_persistence: {exc}"
            )

    latest = (
        datetime.fromisoformat(max(history))
        if history
        else None
    )

    age_hours = (
        (
            now
            - latest
            - timedelta(minutes=30)
        ).total_seconds() / 3600
        if latest
        else None
    )

    fresh = (
        age_hours is not None
        and -0.5 <= age_hours <= MAX_AGE_HOURS
    )

    # Evaluate newly downloaded observations chronologically.
    for ts, maximum in sorted(new_obs):

        if (
            maximum is None
            or rain_threshold is None
        ):
            continue

        if maximum >= rain_threshold:
            state["storm_active"] = True
            state[
                "consecutive_dry_observations"
            ] = 0

        elif state.get("storm_active"):

            state[
                "consecutive_dry_observations"
            ] = (
                state.get(
                    "consecutive_dry_observations",
                    0
                ) + 1
            )

            dry_required = max(
                1,
                int(
                    os.getenv(
                        "DRY_OBSERVATIONS_TO_RESET",
                        "6"
                    )
                )
            )

            if (
                state[
                    "consecutive_dry_observations"
                ] >= dry_required
            ):
                state["storm_active"] = False
                state[
                    "consecutive_dry_observations"
                ] = 0

    if rain_threshold is None:
        state["storm_active"] = False

    season = monsoon(now)

    active = bool(
        state.get("storm_active", False)
    )

    mode = (
        "monsoon_30min"
        if season
        else (
            "storm_30min"
            if active
            else "nonmonsoon_daily"
        )
    )

    due = (
        season
        or active
        or state.get(
            "last_full_run_local_date"
        ) != today
    )

    full_success = False
    pipeline_result = None

    if due:
        try:
            pipe.LOOKBACK_HOURS = 8
            pipe.MAX_NEW_DOWNLOADS = 10

            pipeline_result = pipe.main()

            if not isinstance(
                pipeline_result, dict
            ):
                raise RuntimeError(
                    "Pipeline must return a result dictionary"
                )

            if not pipeline_result.get(
                "completed", False
            ):
                raise RuntimeError(
                    "Pipeline did not report completion"
                )

            if pipeline_result.get(
                "processing_failed", 0
            ) != 0:
                raise RuntimeError(
                    "Pipeline reported processing failures"
                )

            full_success = True

            state[
                "last_full_run_local_date"
            ] = today

            state[
                "last_full_run_utc"
            ] = now.isoformat()

        except Exception as exc:
            errors.append(
                f"full_pipeline: {exc}"
            )

    windows = (
        update_windows(
            history, lat, lon, now
        )
        if history
        else {}
    )

    backlog_remaining = max(
        0,
        backlog_before - backlog_processed
    )

    status = {
        "checked_at_utc": now.isoformat(),
        "mode": mode,
        "monsoon": season,
        "storm_active": active,
        "threshold_configured":
            rain_threshold is not None,
        "rain_trigger_threshold_30min_mm":
            rain_threshold,
        "latest_observation_start_utc":
            latest.isoformat() if latest else None,
        "observation_age_hours":
            round(age_hours, 2)
            if age_hours is not None
            else None,
        "data_fresh": fresh,
        "new_observations": len(new_obs),
        "stored_observations": len(history),
        "backlog_before": backlog_before,
        "backlog_processed": backlog_processed,
        "backlog_remaining": backlog_remaining,
        "failed_observations": failed_observations,
        "rainfall_windows": windows,
        "full_pipeline_attempted": due,
        "full_pipeline_succeeded": full_success,
        "pipeline_result": pipeline_result,
        "last_successful_full_run_utc":
            state.get("last_full_run_utc"),
        "errors": errors,
        "warning":
            "Observed IMERG Early Run; not a "
            "forecast or validated landslide warning"
    }

    write_json(STATE, state)
    write_json(STATUS, status)

    print(
        json.dumps(status, indent=2)
    )

    if errors or not fresh:
        sys.exit(1)


if __name__ == "__main__":
    run()
