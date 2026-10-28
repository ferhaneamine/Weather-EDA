# Weather History EDA Project

This project reads `datasets/weatherHistory.csv` and stores the results in a SQLite database at `reports/weather_eda.db`. The database contains calculated summaries and chart-ready data. The included Flask dashboard reads from that database and renders interactive visualizations; it does not rerun EDA or need the source CSV for display. The EDA program itself creates no images.

## Structure

```text
Weather_EDA_Project/
├── app.py                   # Flask server (dashboard + JSON API)
├── main.py                  # runs the analysis and stores it in SQLite
├── database.py              # SQLite save/load layer
├── register_datasets.py     # fills the dataset cards on the Overview page
├── requirements.txt
├── README.md
├── datasets/
│   ├── weatherHistory.csv   # source data for main.py
│   └── previews.json        # first rows of the 10 datasets (used by register_datasets.py)
├── reports/
│   └── weather_eda.db       # SQLite database (generated, do not edit by hand)
├── templates/
│   └── index.html           # page structure
└── static/
    ├── css/style.css
    └── js/
        ├── dashboard.js     # fetches the report and draws every chart and table
        ├── layout.js        # page navigation (sidebar, previous/next)
        ├── descriptions.js  # editable description boxes
        └── datasets.js      # dataset cards on the Overview page
```

## Install and run (Windows PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python register_datasets.py --builtin
python main.py
python app.py
```

`register_datasets.py --builtin` fills the dataset cards (and the rows shown when you click a card) on the Overview page and only needs to run once. `main.py` is only needed to rebuild the analysis; the repository already contains a finished `reports/weather_eda.db`, so `python app.py` alone is enough to open the dashboard.

Open `http://127.0.0.1:5000` after starting Flask. If the database is missing, generate it with `python main.py`. Plotly.js is loaded from its public CDN, so an internet connection is needed for interactive chart rendering. The dashboard endpoint rebuilds the complete report from `reports/weather_eda.db`.

`main.py` resolves paths relative to itself and creates `reports/` when needed. It reads the CSV and applies transformations only to in-memory DataFrames. It never modifies the source CSV.

## Features & GUI Enhancements

- **Data Quality Flags & Domain Checks:** Exploratory flags cover zero pressure, zero humidity, missing precipitation types, constant-valued columns, and possible visibility ceilings. They do not establish sensor failure or physical impossibility. Confirm source encodings, measurement precision, and instrument limits before recoding, imputing, or excluding observations. The feature matrix is a review aid, not a source-verified diagnosis.
- **Timestamp Coverage:** UTC-normalized coverage, duplicate timestamp counts, one-hour interval checks, largest gaps, and records by month and UTC hour.
- **Interpretation Guides:** Every dashboard section and major chart includes plain-language guidance for reading its values, understanding what patterns can mean, and recognizing limits. Model feature labels distinguish source predictors from timestamp-derived inputs.

- **Interactive Statistical Description (Min, Max, Mean, Quartiles...):**
  - Complete `describe()` summary table displaying Non-missing Count, Mean, Std Dev, Min, 25% (Q1), Median (50%), 75% (Q3), Max, IQR, Skewness (with directional classification badges), Zero counts & percentages.
  - In-cell visual range indicators displaying the distribution span and interquartile box ($Q1 \to \text{Median} \to Q3$).
  - Full column sorting, real-time variable filtering, and one-click CSV export (`weather_history_features_description.csv`).
  - Categorical feature breakdown with mode frequencies and category share progress bars.
  - Interactive row clicking jumps directly into that feature's deep-dive distribution.

- **All Features KDE Gallery & Standardized Comparative Overlay:**
  - Simultaneous 8-card responsive gallery rendering every numerical feature's Gaussian KDE curve at once with peak mode, mean, std, range, and bandwidth metrics.
  - Standardized comparative overlay ($(X - \mu)/\sigma$) mapping all continuous atmospheric variables onto a single axis to compare modality, symmetry, and tail thickness.
  - Graceful handling of constant zero variables (e.g. `Loud Cover`).

- **Distribution Deep Dive:** Single-feature histogram (40 bins) with high-resolution KDE overlay, interactive box plot vs. mirrored density silhouette (violin) toggle, categorical bars, and 500-row deterministic missingness pattern matrix.
- **Multivariate Correlations:** Interactive Pearson and Spearman heatmaps with target correlation indicators.
- **Quality & Anomaly Detection:** 11-point centered rolling Hampel filter with 3×MAD outlier flags and 99% $\chi^2$ multivariate Mahalanobis distance alerts with searchable, paginated row-level tables.
- **Predictive Machine Learning Evaluation:** Comparative Random Forest experiments (with/without derived apparent temperature) featuring MAE, RMSE, $R^2$, impurity importance (MDI), 5-repeat held-out permutation importance, an expanding-window chronological validation for the no-apparent-temperature model, and a calendar month × hour climatology baseline.

## Database layout (SQLite)

| Table | Content |
|---|---|
| `report_sections` | one row per report section (`kde`, `correlation_analysis`, `feature_importance`, ...), stored as JSON text |
| `hampel_flags` | one row per Hampel-flagged observation (feature, row_index, timestamp, value, rolling_median, scaled_mad, threshold, detection_score) |
| `mahalanobis_flags` | one row per multivariate anomaly (row_index, timestamp, distance, squared_distance) |
| `datasets` | name, rows, columns and the first 200 rows of each dataset; shown as cards on the Overview page, a click opens the rows (`python register_datasets.py`) |
| `descriptions` | hand-written description shown under each plot and table (key, label, text); kept when `main.py` is re-run |

Example queries:

```sql
SELECT feature, COUNT(*) FROM hampel_flags GROUP BY feature;
SELECT * FROM mahalanobis_flags ORDER BY distance DESC LIMIT 10;
```

### Dashboard layout

The dashboard shows one page at a time. Use the sidebar (or the Previous / Next buttons at the bottom of each page) to move between them:

| Group | Page | Content |
|---|---|---|
| Start | Overview | summary and key numbers |
| Data | Data Quality | time coverage, quality flags and domain checks |
| Data | Statistics | descriptive statistics tables |
| Analysis | Distributions | KDE gallery and single-feature deep dive (histogram, box plot, missing data) |
| Analysis | Relationships | Pearson and Spearman correlations |
| Analysis | Anomalies | Hampel filter and Mahalanobis distance |
| Modeling | Models | model comparison and feature importance |

The page is part of the URL (for example `http://127.0.0.1:5000/#anomalies`), so a page can be bookmarked or linked.

### Description boxes

Every plot and table has a small box underneath it. Click **Add description** / **Edit** in the dashboard, type the text and press **Save**; it is stored in the `descriptions` table. You can also edit the texts directly with SQL:

```sql
UPDATE descriptions SET text = 'Your text' WHERE key = 'correlation-chart';
```

`python database.py <old_report.json>` imports an older JSON report into the database.

## Report structure

The report (stored as described above) uses schema version `1.0.0`, an ISO-8601 UTC generation time, JSON-safe values (`NaN`/infinity become `null`), and no local-path dependency. After saving, the program reads the report back from the database and checks KDE array lengths and correlation matrix dimensions before finishing.

Top-level sections: `metadata`, `dataset_overview`, `temporal_analysis`, `missing_data`, `descriptive_statistics`, `distributions`, `kde`, `correlation_analysis`, `noise_detection`, `anomaly_detection`, `feature_importance`, `chart_data`, `interpretations`, and `limitations`. The `chart_data` section provides convenient chart series; detailed observations and method notes live in their analysis sections. KDE records have `x` and `density` arrays, sample counts, bandwidth method, sampling flag, status, and limitation. Histogram edges correspond to adjacent bins; matrix row and column order is explicit. The dashboard renders overview cards, histograms with KDE lines, box summaries, category counts, missingness bars, Pearson/Spearman heatmaps, Hampel time series and searchable flags, Mahalanobis distance histogram and alerts, plus both model importance methods and metrics.

The dashboard receives the complete report from `GET /api/report`. It renders the supplied arrays and tables directly and does not recompute EDA in the browser, so the web layer is responsible only for visual rendering and interactions. Other endpoints: `GET /api/datasets` and `GET /api/datasets/<id>` (dataset cards and the rows of one dataset) and `GET/PUT /api/descriptions` (description boxes).

## Assumptions and limitations

CSV data are analyzed as supplied; zero is not treated as missing and duplicate records are counted, not removed. Date parsing uses pandas with UTC normalization for sorting and timestamps. Time gaps may reflect source coverage or cadence. The Mahalanobis threshold is approximate when data are non-normal or covariance needs stabilization. Random Forest importance can be biased by correlated features; apparent temperature is derived from temperature and is included only in a separately labeled comparison. Rolling-origin and held-out scores describe this dataset and period, not guaranteed future performance. Some chart arrays are binned or sampled as documented, while complete missing totals, flagged observations, categorical frequencies, and model tables are retained.
