"""SQLite storage for the weather EDA report.

Layout
------
report_sections    one row per top-level report section (JSON text), e.g. 'kde'
hampel_flags       one row per Hampel-flagged observation (queryable with SQL)
mahalanobis_flags  one row per multivariate (Mahalanobis) anomaly
datasets           name, size and first rows of each dataset shown on the Overview
                   (filled by register_datasets.py, kept when main.py is re-run)
descriptions       hand-written description shown under each plot / table
                   (kept when main.py is re-run, edit them in the dashboard
                   or directly in SQL)

The dashboard still receives the same report structure as before:
load_report() rebuilds it from these tables.
"""
from __future__ import annotations

import json
import sqlite3
import sys
from contextlib import closing
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "reports" / "weather_eda.db"

# (key, label). The key is the id of the plot/table in the dashboard.
DESCRIPTION_TARGETS = [
    ("monthly-chart", "Records by Month (plot)"),
    ("hourly-chart", "Records by UTC Hour (plot)"),
    ("numerical-stats-table", "Numerical Feature Properties (table)"),
    ("categorical-stats-table", "Categorical Feature Properties (table)"),
    ("health-gauge-plot", "Data health gauge (plot)"),
    ("audit-table", "Data quality audit (table)"),
    ("kde-grid-container", "KDE gallery, all features (plots)"),
    ("kde-overlay-chart", "Standardized KDE overlay (plot)"),
    ("distribution-chart", "Distribution histogram + KDE (plot)"),
    ("box-chart", "Box plot / violin (plot)"),
    ("category-chart", "Category frequency (plot)"),
    ("missing-chart", "Missing data by field (plot)"),
    ("missing-matrix-chart", "Missingness pattern matrix (plot)"),
    ("correlation-chart", "Correlation heatmap (plot)"),
    ("hampel-chart", "Hampel filter explorer (plot)"),
    ("anomaly-chart", "Mahalanobis distance (plot)"),
    ("noise-table", "Hampel flagged records (table)"),
    ("anomaly-table", "Mahalanobis alerts (table)"),
    ("model-comparison", "Model performance comparison (plots)"),
    ("impurity-chart", "Impurity-based importance (plot)"),
    ("permutation-chart", "Permutation importance (plot)"),
    ("model-fi-table", "Feature importance leaderboard (table)"),
]
MAX_DESCRIPTION_LENGTH = 2000

HAMPEL_COLS = ["row_index", "timestamp", "value", "rolling_median", "raw_mad",
               "scaled_mad", "absolute_deviation", "threshold", "detection_score"]
MAHA_COLS = ["row_index", "timestamp", "distance", "squared_distance", "flagged"]

SCHEMA = f"""
CREATE TABLE IF NOT EXISTS report_sections (
    section TEXT PRIMARY KEY,
    position INTEGER NOT NULL,
    payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hampel_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature TEXT NOT NULL,
    row_index INTEGER, timestamp TEXT, value REAL, rolling_median REAL,
    raw_mad REAL, scaled_mad REAL, absolute_deviation REAL,
    threshold REAL, detection_score REAL
);
CREATE INDEX IF NOT EXISTS idx_hampel_feature ON hampel_flags(feature);
CREATE INDEX IF NOT EXISTS idx_hampel_time ON hampel_flags(timestamp);
CREATE TABLE IF NOT EXISTS mahalanobis_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    row_index INTEGER, timestamp TEXT, distance REAL,
    squared_distance REAL, flagged INTEGER
);
CREATE INDEX IF NOT EXISTS idx_maha_time ON mahalanobis_flags(timestamp);
CREATE TABLE IF NOT EXISTS datasets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    position INTEGER NOT NULL,
    name TEXT NOT NULL,
    file_name TEXT NOT NULL UNIQUE,
    row_count INTEGER,
    column_count INTEGER,
    preview TEXT
);
CREATE TABLE IF NOT EXISTS descriptions (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    updated_at TEXT
);
"""


def connect(path: Path = DB_PATH) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    with conn:  # databases created before the preview column existed
        if "preview" not in [r[1] for r in conn.execute("PRAGMA table_info(datasets)")]:
            conn.execute("ALTER TABLE datasets ADD COLUMN preview TEXT")
    with conn:  # one (empty) row per plot/table, existing texts are kept
        for key, label in DESCRIPTION_TARGETS:
            conn.execute("INSERT OR IGNORE INTO descriptions(key, label) VALUES (?, ?)", (key, label))
            conn.execute("UPDATE descriptions SET label = ? WHERE key = ?", (label, key))
    return conn


def list_datasets(path: Path = DB_PATH) -> list[dict]:
    with closing(connect(path)) as conn:
        rows = conn.execute(
            "SELECT id, name, file_name, row_count, column_count FROM datasets ORDER BY position"
        ).fetchall()
    return [{"id": i, "name": n, "file_name": f, "rows": r, "columns": c} for i, n, f, r, c in rows]


def get_dataset(dataset_id: int, path: Path = DB_PATH) -> dict | None:
    """One dataset with its stored preview: {"columns": [...], "rows": [[...], ...]}."""
    with closing(connect(path)) as conn:
        row = conn.execute(
            "SELECT id, name, file_name, row_count, column_count, preview FROM datasets WHERE id = ?",
            (dataset_id,)).fetchone()
    if row is None:
        return None
    i, n, f, r, c, preview = row
    return {"id": i, "name": n, "file_name": f, "rows": r, "columns": c,
            "preview": json.loads(preview) if preview else None}


def save_datasets(items: list[dict], path: Path = DB_PATH) -> None:
    """Replace the dataset list. items: dicts with name, file_name, rows, columns, preview (optional)."""
    with closing(connect(path)) as conn, conn:
        conn.execute("DELETE FROM datasets")
        conn.executemany(
            "INSERT INTO datasets(position, name, file_name, row_count, column_count, preview) VALUES (?,?,?,?,?,?)",
            [(i, it["name"], it["file_name"], it["rows"], it["columns"],
              json.dumps(it["preview"], ensure_ascii=False, allow_nan=False) if it.get("preview") else None)
             for i, it in enumerate(items)])


def list_descriptions(path: Path = DB_PATH) -> list[dict]:
    order = {key: i for i, (key, _) in enumerate(DESCRIPTION_TARGETS)}
    with closing(connect(path)) as conn:
        rows = conn.execute("SELECT key, label, text FROM descriptions").fetchall()
    rows = [{"key": k, "label": l, "text": t} for k, l, t in rows if k in order]
    return sorted(rows, key=lambda r: order[r["key"]])


def set_description(key: str, text: str, path: Path = DB_PATH) -> bool:
    """Save one description. Returns False if the key is unknown."""
    text = text.strip()[:MAX_DESCRIPTION_LENGTH]
    with closing(connect(path)) as conn, conn:
        cur = conn.execute(
            "UPDATE descriptions SET text = ?, updated_at = datetime('now') WHERE key = ?",
            (text, key))
        return cur.rowcount > 0


def save_report(report: dict, path: Path = DB_PATH) -> None:
    """Replace the whole database content with `report` (one transaction)."""
    report = json.loads(json.dumps(report))  # private copy, we edit it below
    hampel_rows, maha_rows = [], []

    for feature, rec in report.get("noise_detection", {}).get("features", {}).items():
        for obs in rec.get("flagged_observations", []):
            hampel_rows.append((feature, *[obs.get(c) for c in HAMPEL_COLS]))
        rec["flagged_observations"] = []

    anomaly = report.get("anomaly_detection", {})
    for obs in anomaly.get("flagged_observations", []):
        vals = [obs.get(c) for c in MAHA_COLS]
        vals[-1] = None if vals[-1] is None else int(bool(vals[-1]))
        maha_rows.append(tuple(vals))
    anomaly["flagged_observations"] = []

    with closing(connect(path)) as conn, conn:
        for table in ("report_sections", "hampel_flags", "mahalanobis_flags"):
            conn.execute(f"DELETE FROM {table}")
        conn.executemany(
            "INSERT INTO report_sections(section, position, payload) VALUES (?,?,?)",
            [(k, i, json.dumps(v, ensure_ascii=False, allow_nan=False))
             for i, (k, v) in enumerate(report.items())])
        conn.executemany(
            f"INSERT INTO hampel_flags(feature,{','.join(HAMPEL_COLS)}) "
            f"VALUES ({','.join('?' * (len(HAMPEL_COLS) + 1))})", hampel_rows)
        conn.executemany(
            f"INSERT INTO mahalanobis_flags({','.join(MAHA_COLS)}) "
            f"VALUES ({','.join('?' * len(MAHA_COLS))})", maha_rows)


def load_report(path: Path = DB_PATH) -> dict:
    """Rebuild the report dictionary expected by the dashboard."""
    if not path.exists():
        raise FileNotFoundError("Database not found. Run `python main.py` first.")
    with closing(connect(path)) as conn:
        rows = conn.execute(
            "SELECT section, payload FROM report_sections ORDER BY position").fetchall()
        if not rows:
            raise FileNotFoundError("Database is empty. Run `python main.py` first.")
        report = {name: json.loads(payload) for name, payload in rows}

        features = report.get("noise_detection", {}).get("features", {})
        for rec in features.values():
            rec["flagged_observations"] = []
        cur = conn.execute(
            f"SELECT feature,{','.join(HAMPEL_COLS)} FROM hampel_flags ORDER BY id")
        for feature, *vals in cur:
            if feature in features:
                features[feature]["flagged_observations"].append(dict(zip(HAMPEL_COLS, vals)))

        flagged = []
        for vals in conn.execute(
                f"SELECT {','.join(MAHA_COLS)} FROM mahalanobis_flags ORDER BY id"):
            obs = dict(zip(MAHA_COLS, vals))
            if obs["flagged"] is not None:
                obs["flagged"] = bool(obs["flagged"])
            flagged.append(obs)
        report.setdefault("anomaly_detection", {})["flagged_observations"] = flagged
    return report


if __name__ == "__main__":
    # Optional one-time import of an existing JSON report:
    #   python database.py reports/weather_history_report.json
    if len(sys.argv) == 2:
        src = Path(sys.argv[1])
        save_report(json.loads(src.read_text(encoding="utf-8")))
        print(f"Imported {src.name} into {DB_PATH}")
    else:
        print(__doc__)
