"""Flask dashboard for the weather EDA report stored in SQLite.

Routes
------
GET  /                                  dashboard page
GET  /api/report                        full analysis report (from SQLite)
GET  /api/datasets, /api/datasets/<id>  dataset cards and their first rows
GET  /api/descriptions                  hand-written plot / table descriptions
PUT  /api/descriptions/<key>
GET  /api/weather/temperature           hourly temperature series (all dated rows)
GET  /api/weather/correlation-points    scatter points + regression for any two features
GET  /api/weather/mahalanobis-points    scatter of two features, outliers highlighted
"""
from __future__ import annotations

import math
import threading
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request

from database import DB_PATH, get_dataset, list_datasets, list_descriptions, load_report, set_description

ROOT = Path(__file__).resolve().parent
WEATHER_CSV = ROOT / "datasets" / "weatherHistory.csv"
DATE_COL = "Formatted Date"
TARGET = "Temperature (C)"

MAX_SCATTER_POINTS = 12000      # correlation scatter: evenly spaced sample of the complete pairs
MAX_NORMAL_POINTS = 3000        # Mahalanobis scatter: sampled normal rows (every outlier is kept)
HISTOGRAM_BINS = 40

UNITS = {
    "Temperature (C)": "°C", "Apparent Temperature (C)": "°C", "Humidity": "fraction",
    "Wind Speed (km/h)": "km/h", "Wind Bearing (degrees)": "degrees",
    "Visibility (km)": "km", "Pressure (millibars)": "millibars", "Loud Cover": "source code (constant 0)",
}
DETAIL_FEATURES = ["Temperature (C)", "Apparent Temperature (C)", "Humidity", "Wind Speed (km/h)",
                   "Wind Bearing (degrees)", "Visibility (km)", "Pressure (millibars)", "Loud Cover"]

app = Flask(__name__)
_lock = threading.Lock()
_cache: dict = {}


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


@app.errorhandler(ApiError)
def handle_api_error(exc: ApiError):
    return jsonify({"error": exc.message}), exc.status


def clean(values) -> list:
    """numpy array / list -> plain list with NaN and infinity turned into null."""
    arr = np.asarray(values, dtype=float)
    return [float(v) if math.isfinite(v) else None for v in arr.tolist()]


# --------------------------------------------------------------------------- data access
def weather_frame() -> dict:
    """The source CSV (numeric columns converted, dates parsed to UTC), loaded once."""
    with _lock:
        if "weather" not in _cache:
            if not WEATHER_CSV.is_file():
                raise ApiError(f"Source data not found: {WEATHER_CSV.name} (expected in the datasets folder).", 404)
            df = pd.read_csv(WEATHER_CSV, low_memory=False)
            numeric = [c for c in df.columns if c != DATE_COL and pd.to_numeric(df[c], errors="coerce").notna().any()]
            for c in numeric:
                df[c] = pd.to_numeric(df[c], errors="coerce")
            dates = pd.to_datetime(df[DATE_COL], errors="coerce", utc=True) if DATE_COL in df else None
            _cache["weather"] = {"df": df, "numeric": numeric, "dates": dates}
        return _cache["weather"]


def anomaly_state() -> dict:
    """Mahalanobis results stored in the database (reloaded when the database changes)."""
    stamp = DB_PATH.stat().st_mtime if DB_PATH.exists() else None
    with _lock:
        cached = _cache.get("anomaly")
        if cached and cached["stamp"] == stamp:
            return cached
    try:
        section = load_report()["anomaly_detection"]
    except FileNotFoundError as exc:
        raise ApiError(str(exc), 404)
    obs = section.get("all_observations")
    if section.get("status") != "ok" or not obs:
        raise ApiError("Mahalanobis results are not available. Run `python main.py` first.", 404)
    state = {
        "stamp": stamp,
        "threshold": float(section["threshold"]),
        "features": section.get("selected_features", []),
        "row_index": np.asarray(obs["row_index"], dtype=int),
        "d2": np.asarray(obs["squared_distance"], dtype=float),
        "flagged": np.asarray(obs["flagged"], dtype=bool),
    }
    with _lock:
        _cache["anomaly"] = state
    return state


def feature_pair() -> tuple[str, str, dict]:
    data = weather_frame()
    x, y = request.args.get("x", ""), request.args.get("y", "")
    for name in (x, y):
        if name not in data["numeric"]:
            raise ApiError(f"Unknown feature: {name!r}")
    return x, y, data


# --------------------------------------------------------------------------- pages and report
@app.get("/")
def dashboard():
    return render_template("index.html")


@app.get("/api/report")
def report_api():
    try:
        return jsonify(load_report())
    except FileNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except Exception as exc:  # corrupted or unreadable database
        return jsonify({"error": f"Could not read the database: {exc}"}), 500


# --------------------------------------------------------------------------- datasets and descriptions
@app.get("/api/datasets")
def datasets_api():
    return jsonify(list_datasets())


@app.get("/api/datasets/<int:dataset_id>")
def dataset_api(dataset_id: int):
    dataset = get_dataset(dataset_id)
    if dataset is None:
        return jsonify({"error": "Unknown dataset"}), 404
    return jsonify(dataset)


@app.get("/api/descriptions")
def descriptions_api():
    return jsonify(list_descriptions())


@app.put("/api/descriptions/<key>")
def description_update(key: str):
    payload = request.get_json(silent=True) or {}
    text = payload.get("text")
    if not isinstance(text, str):
        return jsonify({"error": "Body must be JSON like {\"text\": \"...\"}"}), 400
    if not set_description(key, text):
        return jsonify({"error": f"Unknown description key: {key}"}), 404
    return jsonify({"key": key, "text": text.strip()})


# --------------------------------------------------------------------------- weather explorers
@app.get("/api/weather/temperature")
def weather_temperature():
    """Every row with a valid timestamp, so the chart can show any month at full resolution."""
    with _lock:
        cached = _cache.get("temperature")
    if cached:
        return jsonify(cached)
    data = weather_frame()
    df, dates = data["df"], data["dates"]
    if dates is None or TARGET not in df:
        raise ApiError("The weather data has no usable date or temperature column.", 404)
    ok = dates.notna().to_numpy()
    payload = {
        "dates": dates[ok].dt.strftime("%Y-%m-%dT%H:%M:%S").tolist(),
        "source_dates": df.loc[ok, DATE_COL].astype(str).tolist(),
        "temperatures": clean(df.loc[ok, TARGET]),
        "months": dates[ok].dt.month.astype(int).tolist(),
        "row_index": df.index[ok].astype(int).tolist(),
        "plotted_count": int(ok.sum()),
        "sampling": "No sampling was applied: every row with a valid timestamp is available (dates shown in UTC).",
    }
    with _lock:
        _cache["temperature"] = payload
    return jsonify(payload)


@app.get("/api/weather/correlation-points")
def weather_correlation_points():
    x, y, data = feature_pair()
    df = data["df"]
    pair = df[[x, y]].replace([np.inf, -np.inf], np.nan).dropna()
    valid = len(pair)
    xs, ys = pair[x].to_numpy(float), pair[y].to_numpy(float)
    r = slope = intercept = None
    if valid >= 3 and xs.std() > 0 and ys.std() > 0:
        r = float(np.corrcoef(xs, ys)[0, 1])
        slope = float(np.cov(xs, ys, bias=True)[0, 1] / xs.var())
        intercept = float(ys.mean() - slope * xs.mean())
    keep = np.arange(valid) if valid <= MAX_SCATTER_POINTS else np.linspace(0, valid - 1, MAX_SCATTER_POINTS).astype(int)
    return jsonify({
        "x": x, "y": y, "x_unit": UNITS.get(x, ""), "y_unit": UNITS.get(y, ""),
        "x_values": clean(xs[keep]), "y_values": clean(ys[keep]),
        "row_index": pair.index.to_numpy()[keep].astype(int).tolist(),
        "pearson_r": r, "valid_count": int(valid), "plotted_count": int(len(keep)),
        "regression": {"slope": slope, "intercept": intercept,
                       "x_min": float(xs.min()) if valid else None, "x_max": float(xs.max()) if valid else None},
    })


@app.get("/api/weather/mahalanobis-points")
def weather_mahalanobis_points():
    x, y, data = feature_pair()
    state = anomaly_state()
    df, dates = data["df"], data["dates"]
    rows, d2, flagged, threshold = state["row_index"], state["d2"], state["flagged"], state["threshold"]

    out_pos = np.flatnonzero(flagged)                       # every detected outlier is returned
    normal_pos = np.flatnonzero(~flagged)
    if len(normal_pos) > MAX_NORMAL_POINTS:
        normal_pos = normal_pos[np.linspace(0, len(normal_pos) - 1, MAX_NORMAL_POINTS).astype(int)]

    def point(pos: int, detail: bool) -> dict:
        row = int(rows[pos])
        record = {
            "row_index": row, "flagged": bool(flagged[pos]), "squared_distance": float(d2[pos]),
            "x": clean([df.at[row, x]])[0], "y": clean([df.at[row, y]])[0],
            "source_date": str(df.at[row, DATE_COL]) if DATE_COL in df else None,
        }
        if detail:
            record["values"] = {f: clean([df.at[row, f]])[0] for f in DETAIL_FEATURES if f in df}
        return record

    points = [point(p, False) for p in normal_pos] + [point(p, True) for p in out_pos]

    edges = np.histogram_bin_edges(d2, bins=HISTOGRAM_BINS)
    below = np.histogram(d2[d2 <= threshold], bins=edges)[0]
    above = np.histogram(d2[d2 > threshold], bins=edges)[0]
    total = int(len(d2))
    return jsonify({
        "x": x, "y": y, "points": points, "threshold": threshold,
        "total_observations": total, "outlier_count": int(flagged.sum()),
        "outlier_percentage": 100 * float(flagged.mean()) if total else 0.0,
        "displayed_normal_count": int(len(normal_pos)), "displayed_outlier_count": int(len(out_pos)),
        "feature_count": len(state["features"]),
        "sampling": "Normal rows are an evenly spaced sample; every detected outlier is kept.",
        "histogram": {"bin_edges": clean(edges), "below_counts": below.astype(int).tolist(),
                      "above_counts": above.astype(int).tolist()},
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
