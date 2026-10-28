#!/usr/bin/env python3
"""Scan a folder of datasets and store each one's name, rows and columns in SQLite.

    python register_datasets.py              # scans ./datasets
    python register_datasets.py --builtin    # inserts the 10 course datasets, no files needed

Each dataset is stored with its name, size and its first 200 rows, which the
dashboard shows when you click a card. Scanning a folder also refreshes
datasets/previews.json, the file --builtin reads the previews from.
    python register_datasets.py C:\\path\\to\\folder

The Overview page shows one card per dataset. Run this again whenever you add,
remove or rename a file. It does not touch the analysis report.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

from database import save_datasets

ROOT = Path(__file__).resolve().parent
PREVIEW_ROWS = 200
PREVIEW_FILE = ROOT / "datasets" / "previews.json"
FIRST = "weatherhistory.csv"          # shown first, the others follow alphabetically

DISPLAY_NAMES = {                       # file name (lowercase) -> name on the card
    "weatherhistory.csv": "Weather History",
    "alcohol.csv": "Alcohol",
    "dataset2-covid19.csv": "COVID-19",
    "dataset2pvpower.xlsx": "PV Power",
    "elictricalload.csv": "Electrical Load",
    "germansolarfarm.csv": "German Solar Farm",
    "heart.csv": "Heart Disease",
    "heart_statlog_cleveland_hungary_final.csv": "Heart Statlog",
    "irradiance-algeriapvdata.xlsx": "Algeria PV Irradiance",
    "parkinson.csv": "Parkinson",
}


BUILTIN = [                              # name, file, rows, columns (measured on the original files)
    ("Weather History", "weatherHistory.csv", 96453, 12),
    ("Alcohol", "alcohol.csv", 390, 6),
    ("Algeria PV Irradiance", "Irradiance-AlgeriaPVData.xlsx", 35040, 3),
    ("COVID-19", "dataset2-covid19.csv", 1736, 34),
    ("Electrical Load", "Elictricalload.csv", 48048, 17),
    ("German Solar Farm", "Germansolarfarm.csv", 6217, 52),
    ("Heart Disease", "heart.csv", 303, 14),
    ("Heart Statlog", "heart_statlog_cleveland_hungary_final.csv", 1190, 12),
    ("Parkinson", "Parkinson.csv", 584, 15),
    ("PV Power", "DataSet2PVPower.xlsx", 564522, 2),
]


def display_name(path: Path) -> str:
    return DISPLAY_NAMES.get(path.name.lower(), path.stem.replace("_", " ").replace("-", " ").title())


def read_csv(path: Path) -> pd.DataFrame:
    with path.open("r", encoding="utf-8", errors="replace") as f:
        header = f.readline()
    sep = max([",", ";", "\t", "|"], key=header.count)     # most frequent delimiter in the header
    try:
        return pd.read_csv(path, sep=sep, low_memory=False)
    except UnicodeDecodeError:
        return pd.read_csv(path, sep=sep, low_memory=False, encoding="latin-1")


def make_preview(df: pd.DataFrame) -> dict:
    """First PREVIEW_ROWS rows as {"columns": [...], "rows": [[...], ...]} (JSON-safe)."""
    head = df.head(PREVIEW_ROWS).copy()
    for col in head.columns:
        if pd.api.types.is_datetime64_any_dtype(head[col]):
            head[col] = head[col].dt.strftime("%Y-%m-%d %H:%M:%S")
        elif head[col].dtype == object:       # text, times, mixed values
            head[col] = head[col].map(
                lambda v: None if pd.isna(v) else (v if isinstance(v, (str, int, float, bool)) else str(v)))
    data = json.loads(head.to_json(orient="split", double_precision=10))
    return {"columns": [str(c) for c in data["columns"]], "rows": data["data"]}


def describe(path: Path) -> dict:
    df = read_csv(path) if path.suffix.lower() == ".csv" else pd.read_excel(path)
    return {"name": display_name(path), "file_name": path.name, "rows": int(len(df)),
            "columns": int(df.shape[1]), "preview": make_preview(df)}


def main() -> None:
    if "--builtin" in sys.argv:
        previews = json.loads(PREVIEW_FILE.read_text(encoding="utf-8")) if PREVIEW_FILE.is_file() else {}
        save_datasets([{"name": n, "file_name": f, "rows": r, "columns": c, "preview": previews.get(f)}
                       for n, f, r, c in BUILTIN])
        print(f"Saved {len(BUILTIN)} datasets ({len(previews)} with a preview).")
        return
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "datasets"
    files = [p for p in folder.iterdir() if p.suffix.lower() in (".csv", ".xlsx", ".xls")]
    items = []
    for p in sorted(files, key=lambda p: (p.name.lower() != FIRST, display_name(p).lower())):
        item = describe(p)
        print(f"{item['name']:24s} {item['rows']:>9,} rows x {item['columns']} columns")
        items.append(item)
    save_datasets(items)
    PREVIEW_FILE.parent.mkdir(exist_ok=True)
    PREVIEW_FILE.write_text(
        json.dumps({it["file_name"]: it["preview"] for it in items}, ensure_ascii=False, allow_nan=False),
        encoding="utf-8")
    print(f"Saved {len(items)} datasets and {PREVIEW_FILE.name}.")


if __name__ == "__main__":
    main()
