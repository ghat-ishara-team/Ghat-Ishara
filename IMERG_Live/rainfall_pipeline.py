
from pathlib import Path
from datetime import datetime, timedelta, timezone
import re
from urllib.parse import urljoin, urlparse, unquote
import time
import requests
from bs4 import BeautifulSoup

import earthaccess
import h5py
import numpy as np
import xarray as xr


# ==========================================
# 1. CONFIGURATION
# ==========================================

BASE_DIR = Path(__file__).resolve().parent
RAW_DIR = BASE_DIR / "raw"
PROCESSED_DIR = BASE_DIR / "processed"

RAW_DIR.mkdir(exist_ok=True)
PROCESSED_DIR.mkdir(exist_ok=True)

# NASA GPM IMERG Early Run V07
DATASET = "GPM_3IMERGHHE"
VERSION = "07"
ARCHIVE_ROOT = (
    "https://gpm1.gesdisc.eosdis.nasa.gov/"
    "data/GPM_L3/GPM_3IMERGHHE.07/"
)

# Temporary study-area bounding box
WEST, EAST = 72.5, 74.6
SOUTH, NORTH = 16.5, 19.3

WINDOWS = {
    "4h": 8,
    "24h": 48,
    "72h": 144
}

# Lightweight near-real-time test: check only recent observations.
# Longer 24h and 72h windows may remain incomplete until expanded.
LOOKBACK_HOURS = 8

# Safety controls
ENABLE_DOWNLOAD = True
DELETE_ORIGINALS = False
MAX_NEW_DOWNLOADS = 10  # Lightweight live-data test; do not download the full backlog
ARCHIVE_TIMEOUT = 45
DOWNLOAD_TIMEOUT = 120


# ==========================================
# 2. TIMESTAMP EXTRACTION
# ==========================================

def extract_timestamp(filename):

    match = re.search(
        r"(\d{8})-S(\d{6})-E(\d{6})",
        filename
    )

    if not match:
        raise ValueError(
            f"Cannot extract timestamp: {filename}"
        )

    return datetime.strptime(
        match.group(1) + match.group(2),
        "%Y%m%d%H%M%S"
    )


# ==========================================
# 3. VALIDATE PROCESSED FILE
# ==========================================

def validate_processed(output, raw_file):

    if not output.exists():
        return False

    try:
        expected_timestamp = extract_timestamp(
            raw_file.name
        ).isoformat()

        with xr.open_dataarray(output) as data:

            if data.name != "rainfall_30min":
                return False

            if data.attrs.get("units") != "mm":
                return False

            if data.attrs.get(
                "observation_start_utc"
            ) != expected_timestamp:
                return False

            if data.dims != ("lat", "lon"):
                return False

            if data.size == 0:
                return False

            values = data.values

            if not np.any(np.isfinite(values)):
                return False

            if np.any(
                values[np.isfinite(values)] < 0
            ):
                return False

        return True

    except Exception:
        return False


# ==========================================
# 4. DOWNLOAD NEW NASA OBSERVATIONS
# ==========================================

def validate_raw_hdf5(path):
    """Confirm that a file contains the datasets needed by our pipeline."""
    try:
        with h5py.File(path, "r") as f:
            if not all(k in f for k in (
                "Grid/precipitation", "Grid/lon", "Grid/lat"
            )):
                return False
            d = f["Grid/precipitation"]
            if len(d.shape) != 3 or d.shape[0] != 1:
                return False
            if d.shape[1] != len(f["Grid/lon"]):
                return False
            if d.shape[2] != len(f["Grid/lat"]):
                return False
        return True
    except (OSError, ValueError, KeyError):
        return False


def archive_directory(day):
    return (
        ARCHIVE_ROOT
        + f"{day.year}/{day.timetuple().tm_yday:03d}/"
    )


def discover_archive_files(session, day):
    """Read one UTC day's directory; return (timestamp, filename, URL)."""
    directory = archive_directory(day)
    response = session.get(directory, timeout=ARCHIVE_TIMEOUT)
    response.raise_for_status()

    if "html" not in response.headers.get("Content-Type", "").lower():
        raise RuntimeError(f"Archive did not return HTML: {directory}")

    soup = BeautifulSoup(response.text, "html.parser")
    files = []
    for anchor in soup.find_all("a", href=True):
        url = urljoin(directory, anchor["href"])
        parsed = urlparse(url)
        filename = unquote(parsed.path.rsplit("/", 1)[-1])
        # Keep only HDF5 granules in the requested directory.
        if not (
            parsed.scheme == "https"
            and parsed.netloc == "gpm1.gesdisc.eosdis.nasa.gov"
            and parsed.path.startswith(urlparse(directory).path)
            and filename.startswith("3B-HHR-E.MS.MRG.3IMERG.")
            and filename.endswith(".HDF5")
        ):
            continue
        try:
            timestamp = extract_timestamp(filename)
        except ValueError:
            continue
        if timestamp.date() == day:
            files.append((timestamp, filename, url))
    return sorted(set(files))


def download_one_hdf5(session, filename, url):
    """Download HDF5 safely, retrying transient failures and invalid data."""

    destination = RAW_DIR / filename
    temporary = RAW_DIR / (filename + ".part")

    if destination.exists() and validate_raw_hdf5(destination):
        print("Already valid locally:", filename)
        return False

    max_attempts = 3

    for attempt in range(1, max_attempts + 1):
        try:
            if temporary.exists():
                temporary.unlink()

            print(
                f"Downloading {filename} "
                f"(attempt {attempt}/{max_attempts})"
            )

            with session.get(
                url,
                stream=True,
                timeout=DOWNLOAD_TIMEOUT
            ) as response:

                response.raise_for_status()

                content_type = response.headers.get(
                    "Content-Type", ""
                ).lower()

                if "text/html" in content_type:
                    raise RuntimeError(
                        "NASA returned HTML instead of HDF5"
                    )

                with temporary.open("wb") as out:
                    for chunk in response.iter_content(
                        chunk_size=1024 * 1024
                    ):
                        if chunk:
                            out.write(chunk)

            if not validate_raw_hdf5(temporary):
                raise ValueError(
                    "Downloaded file failed HDF5 validation"
                )

            temporary.replace(destination)

            print("Downloaded and validated:", filename)
            return True

        except (requests.exceptions.RequestException, ValueError) as error:

            if isinstance(error, requests.exceptions.HTTPError):
                response = error.response

                status = (
                    response.status_code
                    if response is not None
                    else None
                )

                if status not in (429, 500, 502, 503, 504):
                    raise

            if attempt == max_attempts:
                raise RuntimeError(
                    f"Download failed after {max_attempts} "
                    f"attempts: {filename}"
                ) from error

            delay = 2 ** attempt

            print(
                f"Download error: {error}. "
                f"Retrying in {delay} seconds..."
            )

            time.sleep(delay)

        finally:
            if temporary.exists():
                temporary.unlink()


def download_new_observations():
    """Download recent IMERG granules; raise on any attempted download/discovery failure.

    A capped selection is intentional; it does not imply a complete archive.
    """
    if not ENABLE_DOWNLOAD:
        print("Automatic download disabled.")
        return {"download_enabled": False, "discovered": 0,
                "pending": 0, "selected": 0, "downloaded": 0}

    print("\nChecking NASA GES DISC archive directly...")
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=LOOKBACK_HOURS)
    print("Search start:", start.isoformat())
    print("Search end:", now.isoformat())

    try:
        auth = earthaccess.login(strategy="netrc", persist=False)
        if not auth.authenticated:
            raise RuntimeError("Earthdata authentication failed")
        session = earthaccess.get_requests_https_session()
    except Exception as error:
        raise RuntimeError(
            f"NASA authentication/session error: {error}"
        ) from error

    failures = []
    day = start.date()
    candidates = {}
    while day <= now.date():
        try:
            files = discover_archive_files(session, day)
            print(f"Archive {day}: {len(files)} HDF5 links")
            for timestamp, filename, url in files:
                if start.replace(tzinfo=None) <= timestamp <= now.replace(tzinfo=None):
                    candidates[timestamp] = (filename, url)
        except Exception as error:
            print(f"Archive {day} unavailable: {error}")
            failures.append(f"Archive {day}: {error}")
        day += timedelta(days=1)

    print("Observations discovered:", len(candidates))
    pending = []
    for timestamp, (filename, url) in sorted(candidates.items(), reverse=True):
        raw = RAW_DIR / filename
        processed = PROCESSED_DIR / (Path(filename).stem + "_rainfall.nc")
        if raw.exists() and validate_raw_hdf5(raw):
            continue
        if validate_processed(processed, raw):
            continue
        pending.append((filename, url))

    pending_count = len(pending)
    print("Missing observations:", pending_count)
    if MAX_NEW_DOWNLOADS is not None:
        pending = pending[:MAX_NEW_DOWNLOADS]
    print("Selected for this run:", len(pending))

    successful = 0
    for filename, url in pending:
        try:
            if download_one_hdf5(session, filename, url):
                successful += 1
        except Exception as error:
            print("Download failed:", filename, error)
            failures.append(f"Download {filename}: {error}")

    print("New files downloaded:", successful)
    if failures:
        raise RuntimeError(
            "NASA download/discovery failures: " + "; ".join(failures)
        )
    return {"download_enabled": True, "discovered": len(candidates),
            "pending": pending_count, "selected": len(pending),
            "downloaded": successful}


# ==========================================
# 5. PROCESS ORIGINAL HDF5
# ==========================================

def process_file(raw_file):

    output = PROCESSED_DIR / (
        raw_file.stem + "_rainfall.nc"
    )

    if validate_processed(output, raw_file):

        print("Already processed:", raw_file.name)
        return output

    print("Processing:", raw_file.name)

    with h5py.File(raw_file, "r") as f:

        lon = f["Grid/lon"][:]
        lat = f["Grid/lat"][:]

        lon_idx = np.where(
            (lon >= WEST) & (lon <= EAST)
        )[0]

        lat_idx = np.where(
            (lat >= SOUTH) & (lat <= NORTH)
        )[0]

        if len(lon_idx) == 0 or len(lat_idx) == 0:
            raise ValueError(
                "No grid cells in study area."
            )

        dataset = f["Grid/precipitation"]

        units = dataset.attrs.get(
            "units", b""
        )

        if isinstance(units, bytes):
            units = units.decode()

        if units != "mm/hr":
            raise ValueError(
                f"Unexpected units: {units}"
            )

        rain = dataset[
            0,
            lon_idx[0]:lon_idx[-1] + 1,
            lat_idx[0]:lat_idx[-1] + 1
        ].astype(np.float32)

        fill = dataset.attrs.get(
            "_FillValue", -9999.9
        )

        rain[np.isclose(rain, fill)] = np.nan
        rain[~np.isfinite(rain)] = np.nan
        rain[rain < 0] = np.nan

        # mm/hr -> mm per 30 minutes
        rain_mm = (rain * 0.5).T

        rainfall = xr.DataArray(
            rain_mm,
            coords={
                "lat": lat[lat_idx],
                "lon": lon[lon_idx]
            },
            dims=("lat", "lon"),
            name="rainfall_30min",
            attrs={
                "units": "mm",
                "description":
                    "30-minute rainfall accumulation",
                "observation_start_utc":
                    extract_timestamp(
                        raw_file.name
                    ).isoformat(),
                "source":
                    "NASA GPM IMERG Early Run V07"
            }
        )

    temp_output = output.with_suffix(
        ".tmp.nc"
    )

    rainfall.to_netcdf(temp_output)

    try:
        with xr.open_dataarray(
            temp_output
        ) as check:

            np.testing.assert_allclose(
                check.values,
                rainfall.values,
                rtol=0,
                atol=1e-6,
                equal_nan=True
            )

            if (
                check.attrs.get(
                    "observation_start_utc"
                )
                != extract_timestamp(
                    raw_file.name
                ).isoformat()
            ):
                raise RuntimeError(
                    "Timestamp mismatch."
                )

        temp_output.replace(output)

    finally:
        if temp_output.exists():
            temp_output.unlink()

    print("Saved:", output.name)

    return output


# ==========================================
# 6. ROLLING RAINFALL WINDOWS
# ==========================================

def calculate_windows():

    observations = {}

    for file in PROCESSED_DIR.glob(
        "*_rainfall.nc"
    ):

        try:
            timestamp = extract_timestamp(
                file.name
            )

            with xr.open_dataarray(file) as data:

                if (
                    data.name != "rainfall_30min"
                    or data.attrs.get(
                        "units"
                    ) != "mm"
                    or data.attrs.get(
                        "observation_start_utc"
                    ) != timestamp.isoformat()
                    or data.dims != ("lat", "lon")
                ):
                    continue

                observations[timestamp] = data.load()

        except Exception as error:
            print(
                "Skipping invalid observation:",
                file.name,
                error
            )

    if not observations:
        print("No valid observations available.")
        return

    latest = max(observations)

    print("\nLatest observation:", latest, "UTC")

    for label, required in WINDOWS.items():

        expected_times = [
            latest - timedelta(minutes=30 * i)
            for i in range(
                required - 1, -1, -1
            )
        ]

        missing = [
            t for t in expected_times
            if t not in observations
        ]

        output = PROCESSED_DIR / (
            f"rainfall_{label}_latest.nc"
        )

        if missing:

            print(
                f"{label}: INCOMPLETE "
                f"({required - len(missing)}/"
                f"{required} observations)"
            )

            # Remove stale "latest" outputs
            if output.exists():
                output.unlink()

            continue

        stack = xr.concat(
            [
                observations[t]
                for t in expected_times
            ],
            dim="time",
            join="exact"
        )

        valid_count = stack.notnull().sum(
            dim="time"
        )

        total = stack.sum(
            dim="time",
            skipna=True
        ).where(
            valid_count == required
        )

        if not np.any(
            np.isfinite(total.values)
        ):
            print(
                f"{label}: No complete valid cells."
            )

            if output.exists():
                output.unlink()

            continue

        total.name = f"rainfall_{label}"

        total.attrs = {
            "units": "mm",
            "window_hours": required / 2,
            "window_start_utc":
                expected_times[0].isoformat(),
            "window_end_utc":
                (
                    latest
                    + timedelta(minutes=30)
                ).isoformat(),
            "latest_observation_start_utc":
                latest.isoformat(),
            "source":
                "NASA GPM IMERG Early Run V07"
        }

        temp_output = output.with_suffix(
            ".tmp.nc"
        )

        total.to_netcdf(temp_output)

        try:
            with xr.open_dataarray(
                temp_output
            ) as check:

                np.testing.assert_allclose(
                    check.values,
                    total.values,
                    rtol=0,
                    atol=1e-6,
                    equal_nan=True
                )

            temp_output.replace(output)

        finally:
            if temp_output.exists():
                temp_output.unlink()

        print(
            f"{label}: COMPLETE | Maximum: "
            f"{float(total.max()):.2f} mm"
        )

        print("Saved:", output.name)


# ==========================================
# 7. MAIN PIPELINE
# ==========================================

def main():

    print("\nGHAT ISHARA RAINFALL PIPELINE")
    print("=" * 40)

    # Step A: Download available observations
    download_result = download_new_observations()

    # Step B: Process original HDF5 files
    raw_files = sorted(
        RAW_DIR.glob("*.HDF5")
    )

    print(
        "\nOriginal HDF5 files available:",
        len(raw_files)
    )

    successful = 0
    failed = 0

    for file in raw_files:

        try:
            process_file(file)
            successful += 1

        except Exception as error:
            failed += 1

            print(
                "ERROR processing:",
                file.name,
                error
            )

    print("\nPROCESSING SUMMARY")
    print("Successful:", successful)
    print("Failed:", failed)

    # Step C: Calculate rolling totals
    print("\nCalculating rainfall windows...")
    calculate_windows()

    # Step D: Cleanup remains disabled
    if DELETE_ORIGINALS:
        print(
            "Cleanup requested, but deletion "
            "is intentionally not implemented "
            "in this pipeline."
        )
    else:
        print(
            "\nCleanup disabled. "
            "Original HDF5 files retained."
        )

    print("\nPipeline finished.")

    if failed > 0:
        raise RuntimeError(
            f"Rainfall processing failed for {failed} of "
            f"{successful + failed} HDF5 files"
        )

    return {
        "processed_successfully": successful,
        "processing_failed": failed,
        "completed": True,
        "download_result": download_result,
    }


if __name__ == "__main__":
    main()
