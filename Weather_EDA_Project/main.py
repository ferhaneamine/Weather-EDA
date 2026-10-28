#!/usr/bin/env python3
"""Build a portable, chart-ready exploratory report for the weather history data."""
from __future__ import annotations

import json
import hashlib
import math
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import chi2, gaussian_kde
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestRegressor
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder

from database import DB_PATH, load_report, save_report

SEED = 42
MAX_KDE_SAMPLE = 10_000
KDE_GRID_SIZE = 256
MISSING_MATRIX_ROWS = 500
TIME_SERIES_POINTS = 2_000
HISTOGRAM_BINS = 40
PERMUTATION_MAX_TEST_ROWS = 5_000
HAMPEL_WINDOW = 11
HAMPEL_THRESHOLD = 3.0
TARGET = "Temperature (C)"
DATE_COL = "Formatted Date"


def json_safe(value: Any) -> Any:
    """Recursively convert numpy/pandas values to strict JSON-compatible values."""
    if value is None or value is pd.NA or value is pd.NaT:
        return None
    if isinstance(value, dict):
        return {str(k): json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if isinstance(value, (np.ndarray, pd.Series, pd.Index)):
        return [json_safe(v) for v in value.tolist()]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if math.isfinite(float(value)) else None
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, (np.datetime64,)):
        return pd.Timestamp(value).isoformat()
    if isinstance(value, Path):
        return value.name
    return value if isinstance(value, (str, int)) else str(value)


def percentile_summary(series: pd.Series) -> dict[str, Any]:
    vals = pd.to_numeric(series, errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
    if vals.empty:
        return {k: None for k in ("min", "q1", "median", "q3", "max", "lower_fence", "upper_fence")} | {"outlier_count": 0}
    q1, med, q3 = vals.quantile([.25, .5, .75])
    iqr = q3 - q1
    lo, hi = q1 - 1.5 * iqr, q3 + 1.5 * iqr
    return {"min": vals.min(), "q1": q1, "median": med, "q3": q3, "max": vals.max(),
            "lower_fence": lo, "upper_fence": hi,
            "whisker_min": vals[vals >= lo].min() if (vals >= lo).any() else vals.min(),
            "whisker_max": vals[vals <= hi].max() if (vals <= hi).any() else vals.max(),
            "outlier_count": int(((vals < lo) | (vals > hi)).sum())}


def distribution_data(df: pd.DataFrame, numeric: list[str], categorical: list[str]) -> tuple[dict, dict, dict]:
    stats, histograms, boxplots, cats = {}, {}, {}, {}
    for col in numeric:
        s = pd.to_numeric(df[col], errors="coerce").replace([np.inf, -np.inf], np.nan).dropna()
        if s.empty:
            stats[col] = {"count": 0, "unique_count": 0}
            continue
        q1, q3 = s.quantile([.25, .75])
        stats[col] = {"count": int(s.count()), "mean": s.mean(), "median": s.median(), "std": s.std(),
                      "min": s.min(), "max": s.max(), "q1": q1, "q3": q3, "iqr": q3-q1,
                      "skewness": s.skew(), "unique_count": int(s.nunique()),
                      "variance": s.var(), "zero_count": int((s == 0).sum())}
        counts, edges = np.histogram(s.to_numpy(), bins=HISTOGRAM_BINS)
        histograms[col] = {"bin_edges": edges, "counts": counts, "original_count": len(s),
                           "method": "numpy.histogram", "bins": HISTOGRAM_BINS}
        boxplots[col] = percentile_summary(s)
    for col in categorical:
        s = df[col].dropna()
        vc = s.astype(str).value_counts(dropna=False)
        cats[col] = {"non_missing_count": int(s.size), "unique_count": int(s.nunique()),
                     "mode": str(vc.index[0]) if not vc.empty else None,
                     "categories": [{"category": str(k), "count": int(v), "percentage": float(v / max(len(s),1) * 100)} for k,v in vc.items()],
                     "chart_categories": [{"category": str(k), "count": int(v), "percentage": float(v / max(len(s),1) * 100)} for k,v in vc.head(50).items()],
                     "chart_note": "All categories are included; chart_categories is limited to the top 50."}
    return stats, histograms, {"boxplots": boxplots, "categorical": cats}


def kde_data(df: pd.DataFrame, numeric: list[str]) -> dict:
    out = {}
    rng = np.random.default_rng(SEED)
    for col in numeric:
        vals = pd.to_numeric(df[col], errors="coerce").replace([np.inf,-np.inf], np.nan).dropna().to_numpy(dtype=float)
        record = {"method": "Gaussian KDE (scipy.stats.gaussian_kde)", "bandwidth_method": "scott",
                  "original_non_missing_count": len(vals), "sample_size": 0, "sampling_occurred": False,
                  "x": [], "density": [], "status": "skipped", "limitation": None}
        if len(vals) < 2:
            record["limitation"] = "At least two finite observations are required."
        elif np.ptp(vals) == 0:
            record["limitation"] = "Constant-valued data has singular covariance; KDE is undefined."
        else:
            if len(vals) > MAX_KDE_SAMPLE:
                vals = np.sort(rng.choice(vals, MAX_KDE_SAMPLE, replace=False))
                record["sampling_occurred"] = True
            record["sample_size"] = len(vals)
            try:
                kde = gaussian_kde(vals, bw_method="scott")
                sd = float(np.std(vals, ddof=1)); bw = float(kde.factor * sd)
                grid = np.linspace(float(vals.min() - 3*bw), float(vals.max() + 3*bw), KDE_GRID_SIZE)
                record.update({"x": grid, "density": kde(grid), "status": "ok", "bandwidth": bw,
                               "grid_size": KDE_GRID_SIZE, "limitation": "KDE sample is reproducibly capped at 10,000 observations when needed." if record["sampling_occurred"] else None})
            except Exception as exc:
                record["limitation"] = f"KDE computation failed: {type(exc).__name__}: {exc}"
        out[col] = record
    return out


def correlation_data(df: pd.DataFrame, numeric: list[str]) -> dict:
    if numeric:
        x = df[numeric].apply(pd.to_numeric, errors="coerce").replace([np.inf,-np.inf], np.nan)
        pear, spear = x.corr("pearson"), x.corr("spearman")
    else:
        pear = spear = pd.DataFrame()
    def pack(m): return {"features": list(m.columns), "matrix": m.to_numpy(), "method": "Pearson" if m is pear else "Spearman", "null_coefficients": int(m.isna().sum().sum())}
    target_corr = []
    if TARGET in numeric:
        for name, value in pear[TARGET].drop(labels=[TARGET], errors="ignore").items():
            target_corr.append({"feature": name, "pearson": value})
    target_corr.sort(key=lambda d: abs(d["pearson"] or 0), reverse=True)
    relationships = [{"feature": r["feature"], "pearson": r["pearson"]} for r in target_corr]
    return {"pearson": pack(pear), "spearman": pack(spear), "numerical_features": numeric,
            "target_correlations": target_corr,
            "strongest_positive": max(relationships, key=lambda z:z["pearson"] if z["pearson"] is not None else -2, default=None),
            "strongest_negative": min(relationships, key=lambda z:z["pearson"] if z["pearson"] is not None else 2, default=None),
            "notes": ["Pairwise complete observations are used.", "Constant columns and insufficient paired values yield null coefficients.", "Correlation does not imply causation."]}


def temporal_data(df: pd.DataFrame, parsed_dates: pd.Series | None) -> dict:
    """Summarize timestamp coverage and hourly continuity without assuming local time."""
    if parsed_dates is None or not parsed_dates.notna().any():
        return {"status": "skipped", "reason": "No parseable timestamps were available."}
    valid = parsed_dates.dropna().sort_values(kind="stable")
    unique = valid.drop_duplicates().sort_values()
    deltas = unique.diff().dropna()
    counts_by_hour = valid.dt.hour.value_counts().sort_index()
    counts_by_month = valid.dt.tz_localize(None).dt.to_period("M").value_counts().sort_index()
    expected = pd.Timedelta(hours=1)
    gap_deltas = deltas[deltas > expected]
    return {
        "status": "ok", "timezone": "UTC (timestamps normalized from source offsets)",
        "valid_timestamp_count": int(valid.size), "unique_timestamp_count": int(unique.size),
        "duplicate_timestamp_count": int(valid.size - unique.size),
        "start": valid.iloc[0], "end": valid.iloc[-1],
        "hourly_interval_check": {
            "expected_interval": "PT1H", "interval_count": int(deltas.size),
            "exact_one_hour_intervals": int((deltas == expected).sum()),
            "non_hourly_intervals": int((deltas != expected).sum()),
            "gap_count_over_one_hour": int(gap_deltas.size),
            "largest_gap": gap_deltas.max() if not gap_deltas.empty else None,
            "note": "Intervals are calculated between unique timestamps; gaps may reflect source coverage, not necessarily missing rows."
        },
        "hourly_counts": {"hours": [int(x) for x in counts_by_hour.index], "counts": [int(x) for x in counts_by_hour.values]},
        "monthly_counts": {"months": [str(x) for x in counts_by_month.index], "counts": [int(x) for x in counts_by_month.values]},
        "method_note": "Calendar summaries use UTC after parsing the source's explicit offsets."
    }


def seasonal_baseline_predictions(train_dates: pd.Series, train_y: pd.Series, future_dates: pd.Series) -> np.ndarray:
    """Predict with training-only mean temperature for calendar month and hour."""
    train = pd.DataFrame({"month": train_dates.dt.month.to_numpy(), "hour": train_dates.dt.hour.to_numpy(), "target": train_y.to_numpy()})
    by_month_hour = train.groupby(["month", "hour"])["target"].mean()
    by_month = train.groupby("month")["target"].mean()
    overall = float(train_y.mean())
    return np.asarray([
        by_month_hour.get((int(date.month), int(date.hour)), by_month.get(int(date.month), overall))
        for date in future_dates
    ], dtype=float)


def hampel_data(df: pd.DataFrame, numeric: list[str], parsed_dates: pd.Series | None) -> dict:
    order = np.argsort(parsed_dates.fillna(pd.Timestamp.max).astype("int64").to_numpy(), kind="stable") if parsed_dates is not None else np.arange(len(df))
    result, chart = {}, {}
    half = HAMPEL_WINDOW // 2
    for col in numeric:
        vals = pd.to_numeric(df[col], errors="coerce").replace([np.inf,-np.inf], np.nan).to_numpy(dtype=float)[order]
        if len(pd.Series(vals).dropna().unique()) <= 2:
            result[col] = {"status":"skipped", "reason":"Binary or at-most-two-level feature excluded from continuous Hampel detection.", "flag_count":0, "flag_percentage":0.0, "flagged_observations":[]}
            continue
        s = pd.Series(vals)
        med = s.rolling(HAMPEL_WINDOW, center=True, min_periods=1).median()
        mad = s.rolling(HAMPEL_WINDOW, center=True, min_periods=1).apply(lambda x: float(np.median(np.abs(x-np.median(x)))), raw=True)
        scaled = 1.4826 * mad
        deviation = (s-med).abs()
        threshold = HAMPEL_THRESHOLD*scaled
        # At zero local MAD, any nonzero deviation is flagged; undefined rows are never flagged.
        flags = deviation.notna() & ((scaled > 0) & (deviation > threshold) | ((scaled == 0) & (deviation > 0)))
        score = deviation / scaled.replace(0, np.nan)
        if (scaled == 0).any(): score = score.mask((scaled == 0) & (deviation > 0), np.inf)
        indices = np.flatnonzero(flags.to_numpy())
        records = []
        for i in indices:
            orig = int(order[i]); records.append({"row_index":orig, "timestamp": parsed_dates.iloc[orig] if parsed_dates is not None and pd.notna(parsed_dates.iloc[orig]) else None,
                "value": vals[i], "rolling_median":med.iloc[i], "raw_mad":mad.iloc[i], "scaled_mad":scaled.iloc[i], "absolute_deviation":deviation.iloc[i], "threshold":threshold.iloc[i], "detection_score":score.iloc[i]})
        result[col] = {"status":"ok", "flag_count":len(records), "valid_count":int(s.notna().sum()), "flag_percentage":100*len(records)/max(int(s.notna().sum()),1),
                       "flagged_observations":records, "zero_mad_flag_policy":"flag any nonzero deviation when scaled MAD is zero", "window_edge_policy":"centered rolling window; min_periods=1 at edges"}
        # A common deterministic set of chronological positions plus every flagged point.
        keep = set(np.linspace(0, max(len(df)-1,0), min(TIME_SERIES_POINTS,len(df)), dtype=int).tolist()) | {int(order[i]) for i in indices}
        positions = sorted((int(np.where(order == orig)[0][0]), orig) for orig in keep) if len(df) else []
        chart[col] = {"original_count":len(df), "exported_count":len(positions), "sampling":{"method":"evenly spaced chronological positions plus all flagged points", "max_regular_points":TIME_SERIES_POINTS},
                      "row_index":[orig for _,orig in positions], "timestamp":[parsed_dates.iloc[orig] if parsed_dates is not None and pd.notna(parsed_dates.iloc[orig]) else None for _,orig in positions],
                      "observed":[vals[i] for i,_ in positions], "rolling_median":[med.iloc[i] for i,_ in positions], "flagged":[bool(flags.iloc[i]) for i,_ in positions], "threshold":[threshold.iloc[i] for i,_ in positions]}
    return {"parameters":{"method":"rolling Hampel filter", "window_size":HAMPEL_WINDOW, "centered":True, "threshold_multiplier":HAMPEL_THRESHOLD, "mad_scale":1.4826, "sort":"chronologically by parsed Formatted Date; stable original order for ties", "edge_handling":"min_periods=1", "zero_mad":"nonzero deviation is flagged"}, "features":result, "chart_data":chart}


def mahalanobis_data(df: pd.DataFrame, candidates: list[str], parsed_dates: pd.Series | None) -> dict:
    excluded = {TARGET}
    selected = [c for c in candidates if c not in excluded]
    x = df[selected].apply(pd.to_numeric, errors="coerce").replace([np.inf,-np.inf], np.nan) if selected else pd.DataFrame(index=df.index)
    constant = [c for c in selected if x[c].nunique(dropna=True) <= 1]
    x = x.drop(columns=constant)
    selected = list(x.columns)
    base = {"method":"squared Mahalanobis distance", "selected_features":selected, "excluded_features":{"target":TARGET,"constant_features":constant},
            "assumptions":["Complete cases only.","Chi-square cutoff assumes a multivariate-normal reference distribution.","Flags indicate statistical distance, not confirmed errors."],
            "complete_case_count":0,"degrees_of_freedom":len(selected),"threshold":None,"status":"skipped", "flagged_observations":[], "chart_data":{}}
    if len(selected) < 2:
        base["reason"] = "At least two nonconstant numerical predictors are required."
        return base
    valid = x.dropna(); n,p = valid.shape
    base["complete_case_count"] = n
    if n <= p+1:
        base["reason"] = "Complete-case sample is too small relative to feature count."
        return base
    arr = valid.to_numpy(dtype=float); center = arr.mean(axis=0); cov = np.cov(arr, rowvar=False)
    condition = float(np.linalg.cond(cov)); regularized = not np.isfinite(condition) or condition > 1e10
    if regularized:
        ridge = max(float(np.trace(cov)/p)*1e-8, 1e-12)
        cov = cov + np.eye(p)*ridge
    else: ridge = 0.0
    try:
        inv = np.linalg.pinv(cov)
        delta = arr-center
        d2 = np.einsum("ij,jk,ik->i", delta,inv,delta)
    except Exception as exc:
        base["reason"] = f"Distance calculation failed: {type(exc).__name__}: {exc}"
        return base
    threshold = float(chi2.ppf(.99,p)); flags = d2 > threshold
    rows = valid.index.to_numpy()
    recs = [{"row_index":int(rows[i]),"timestamp":parsed_dates.iloc[int(rows[i])] if parsed_dates is not None and pd.notna(parsed_dates.iloc[int(rows[i])]) else None,
             "distance":float(np.sqrt(max(d2[i],0))),"squared_distance":float(d2[i]),"flagged":bool(flags[i])} for i in range(n) if flags[i]]
    counts, edges = np.histogram(d2,bins=HISTOGRAM_BINS)
    base.update({"status":"ok", "threshold":threshold, "threshold_type":"chi-square 99th percentile on squared distance", "degrees_of_freedom":p,
        "covariance_condition_number":condition,"regularization":{"applied":regularized,"ridge_diagonal":ridge},
        "multicollinearity_note":"Condition number is reported; ridge stabilization is applied above 1e10.","flag_count":int(flags.sum()),"flag_percentage":100*float(flags.mean()),
        "flagged_observations":recs,"all_observations":{"row_index":rows,"distance":np.sqrt(np.maximum(d2,0)),"squared_distance":d2,"flagged":flags},
        "chart_data":{"histogram":{"bin_edges":edges,"counts":counts,"value":"squared Mahalanobis distance","original_count":n,"bins":HISTOGRAM_BINS},"threshold_line":threshold}})
    return base


def model_data(df: pd.DataFrame, numeric: list[str], categorical: list[str], parsed_dates: pd.Series | None) -> dict:
    if TARGET not in df:
        return {"status":"skipped","reason":f"Target column {TARGET!r} is unavailable.","experiments":{}}
    y = pd.to_numeric(df[TARGET], errors="coerce")
    feature_frame = pd.DataFrame(index=df.index)
    usable_numeric = [c for c in numeric if c != TARGET]
    for col in usable_numeric: feature_frame[col] = pd.to_numeric(df[col], errors="coerce")
    date_features=[]
    if parsed_dates is not None and parsed_dates.notna().any():
        dt=parsed_dates
        feature_frame["date_hour_sin"] = np.sin(2*np.pi*dt.dt.hour/24); feature_frame["date_hour_cos"] = np.cos(2*np.pi*dt.dt.hour/24)
        feature_frame["date_month"] = dt.dt.month
        days=dt.dt.dayofyear; denom=np.where(dt.dt.is_leap_year,366,365)
        feature_frame["date_day_of_year_sin"] = np.sin(2*np.pi*days/denom); feature_frame["date_day_of_year_cos"] = np.cos(2*np.pi*days/denom)
        date_features=list(feature_frame.columns[-5:])
    categorical_use=[]
    for col in categorical:
        if col in (DATE_COL,"Daily Summary"): continue
        if df[col].nunique(dropna=True) <= 100:
            feature_frame[col]=df[col].astype("string"); categorical_use.append(col)
    feature_frame=feature_frame.replace([np.inf,-np.inf],np.nan)
    # Same complete target and predictor rows for both experiments.
    eligible=feature_frame.notna().all(axis=1)&y.notna()
    X=feature_frame.loc[eligible].copy(); yy=y.loc[eligible].astype(float)
    ordered_idx = X.index
    chrono = parsed_dates is not None and parsed_dates.loc[ordered_idx].notna().all()
    if chrono:
        order=np.argsort(parsed_dates.loc[ordered_idx].astype("int64").to_numpy(),kind="stable")
        X=X.iloc[order]; yy=yy.iloc[order]; ordered_idx=X.index
    else:
        X=X.sort_index(); yy=yy.loc[X.index]; ordered_idx=X.index
    n=len(X); cut=int(np.floor(.70*n))
    output={"status":"ok" if n>=10 and cut>0 and cut<n else "skipped", "reason":None if n>=10 and cut>0 and cut<n else "Fewer than 10 eligible rows or split is empty.",
        "shared_eligible_rows":n,"split":{"method":"chronological 70/30, no shuffle" if chrono else "order-preserving 70/30; chronological order not confirmed", "train_count":cut,"test_count":n-cut,
        "train_start":parsed_dates.loc[ordered_idx[0]] if chrono and cut else None,
        "train_end":parsed_dates.loc[ordered_idx[cut-1]] if chrono and cut else None,"test_start":parsed_dates.loc[ordered_idx[cut]] if chrono and n>cut else None,"test_end":parsed_dates.loc[ordered_idx[-1]] if chrono and n else None},
        "preparation":{"date_features":date_features,"categorical_features":categorical_use,"raw_text_excluded":[c for c in categorical if c not in categorical_use],"target_missing_or_predictor_missing_rows_excluded":int(len(df)-n),"same_rows_and_target_in_both_experiments":True},
        "model":{"class":"RandomForestRegressor","n_estimators":100,"max_depth":20,"max_samples":0.7,"random_state":SEED,"n_jobs":1,"max_features":"1.0","min_samples_leaf":1},"experiments":{}}
    if output["status"] != "ok": return output
    for label, include_apparent in (("A_include_apparent_temperature",True),("B_exclude_apparent_temperature",False)):
        columns=[c for c in X.columns if include_apparent or c!="Apparent Temperature (C)"]
        if not columns:
            output["experiments"][label]={"status":"skipped","reason":"No predictors available."}; continue
        nums=[c for c in columns if c not in categorical_use]; cats=[c for c in columns if c in categorical_use]
        transform=ColumnTransformer([("numeric",SimpleImputer(strategy="median"),nums),
            ("categorical",Pipeline([("imputer",SimpleImputer(strategy="most_frequent")),("onehot",OneHotEncoder(handle_unknown="ignore"))]),cats)], remainder="drop")
        pipe=Pipeline([("preprocess",transform),("model",RandomForestRegressor(n_estimators=100,max_depth=20,max_samples=0.7,random_state=SEED,n_jobs=1,max_features=1.0,min_samples_leaf=1))])
        try:
            pipe.fit(X.iloc[:cut][columns],yy.iloc[:cut]); pred=pipe.predict(X.iloc[cut:][columns]); actual=yy.iloc[cut:]
            rf=pipe.named_steps["model"]; names=pipe.named_steps["preprocess"].get_feature_names_out()
            impurity=rf.feature_importances_
            # Use a reproducible held-out sample for practical runtimes on hourly multi-year data.
            perm_n=min(len(actual),PERMUTATION_MAX_TEST_ROWS)
            if len(actual)>perm_n:
                perm_idx=np.random.default_rng(SEED).choice(len(actual),perm_n,replace=False)
                perm_x=X.iloc[cut:][columns].iloc[perm_idx]
                perm_y=actual.iloc[perm_idx]
            else:
                perm_x=X.iloc[cut:][columns]
                perm_y=actual
            perm=permutation_importance(pipe,perm_x,perm_y,n_repeats=5,random_state=SEED,scoring="r2",n_jobs=1)
            def table(scores,std=None,method=""):
                order=np.argsort(scores)[::-1]
                return [{"feature":str(names[i]),"importance":float(scores[i]),"rank":rank+1,"standard_deviation":float(std[i]) if std is not None else None,
                         "scoring_method":method,"repeats":5 if std is not None else None} for rank,i in enumerate(order)]
            imp=table(impurity,method="mean decrease in impurity")
            per=table(perm.importances_mean,perm.importances_std,"held-out permutation importance; R² decrease")
            metrics={"mae":mean_absolute_error(actual,pred),"rmse":np.sqrt(mean_squared_error(actual,pred)),"r2":r2_score(actual,pred),"train_count":cut,"test_count":n-cut}
            output["experiments"][label]={"status":"ok","include_apparent_temperature":include_apparent,"metrics":metrics,
                "impurity_importance":imp,"permutation_importance":per,"permutation_evaluation":{"method":"reproducible sample of held-out test rows" if perm_n<len(actual) else "all held-out test rows","original_test_count":len(actual),"rows_scored":perm_n,"max_rows":PERMUTATION_MAX_TEST_ROWS,"repeats":5},
                "chart_data":{"impurity":{"features":[i["feature"] for i in imp],"values":[i["importance"] for i in imp]},"permutation":{"features":[i["feature"] for i in per],"values":[i["importance"] for i in per],"standard_deviation":[i["standard_deviation"] for i in per]}}}
        except Exception as exc:
            output["experiments"][label]={"status":"failed","reason":f"{type(exc).__name__}: {exc}"}
    output["interpretation"]="Feature importance describes predictive usefulness in this fitted model, not causation. Correlated predictors can share or distort importance."
    if chrono:
        train_dates=parsed_dates.loc[ordered_idx[:cut]]
        test_dates=parsed_dates.loc[ordered_idx[cut:]]
        baseline_pred=seasonal_baseline_predictions(train_dates,yy.iloc[:cut],test_dates)
        baseline_actual=yy.iloc[cut:]
        output["seasonal_baseline"]={"name":"Calendar month × hour climatology","method":"Mean target by calendar month and hour, learned from the training period only; falls back to month mean, then overall training mean.",
            "metrics":{"mae":mean_absolute_error(baseline_actual,baseline_pred),"rmse":float(np.sqrt(mean_squared_error(baseline_actual,baseline_pred))),"r2":r2_score(baseline_actual,baseline_pred),"train_count":cut,"test_count":n-cut},
            "interpretation":"This simple seasonal reference uses recurring time-of-year and time-of-day averages. A model is more useful when it improves on this baseline on the same future holdout."}
    else:
        output["seasonal_baseline"]={"status":"skipped","reason":"Parseable timestamps are required."}
    output["metric_comparison"]={k:{name:exp.get("metrics",{}).get(k) for name,exp in output["experiments"].items()} for k in ("mae","rmse","r2")}
    if output["seasonal_baseline"].get("metrics"):
        for metric in ("mae","rmse","r2"):
            output["metric_comparison"][metric]["seasonal_climatology"]=output["seasonal_baseline"]["metrics"][metric]
    # Expanding-window checks for the no-apparent-temperature experiment. These
    # folds provide several chronological evaluation windows, not a universal
    # estimate of future performance.
    if chrono and output["experiments"].get("B_exclude_apparent_temperature", {}).get("status") == "ok":
        columns=[c for c in X.columns if c!="Apparent Temperature (C)"]
        nums=[c for c in columns if c not in categorical_use]; cats=[c for c in columns if c in categorical_use]
        folds=[]; horizon=max(1, n//10)
        for train_fraction in (.4,.5,.6):
            train_end=int(n*train_fraction); valid_end=min(n,train_end+horizon)
            if train_end < 10 or valid_end <= train_end: continue
            transform=ColumnTransformer([("numeric",SimpleImputer(strategy="median"),nums),
                ("categorical",Pipeline([("imputer",SimpleImputer(strategy="most_frequent")),("onehot",OneHotEncoder(handle_unknown="ignore"))]),cats)], remainder="drop")
            fold_pipe=Pipeline([("preprocess",transform),("model",RandomForestRegressor(n_estimators=100,max_depth=20,max_samples=0.7,random_state=SEED,n_jobs=1,max_features=1.0,min_samples_leaf=1))])
            fold_pipe.fit(X.iloc[:train_end][columns],yy.iloc[:train_end])
            actual=yy.iloc[train_end:valid_end]; pred=fold_pipe.predict(X.iloc[train_end:valid_end][columns])
            fold_dates=parsed_dates.loc[ordered_idx[train_end:valid_end]]
            baseline_pred=seasonal_baseline_predictions(parsed_dates.loc[ordered_idx[:train_end]],yy.iloc[:train_end],fold_dates)
            folds.append({"train_count":train_end,"validation_count":len(actual),"train_end":parsed_dates.loc[ordered_idx[train_end-1]],
                "validation_start":parsed_dates.loc[ordered_idx[train_end]],"validation_end":parsed_dates.loc[ordered_idx[valid_end-1]],
                "mae":mean_absolute_error(actual,pred),"rmse":float(np.sqrt(mean_squared_error(actual,pred))),"r2":r2_score(actual,pred),
                "seasonal_baseline_mae":mean_absolute_error(actual,baseline_pred),"seasonal_baseline_rmse":float(np.sqrt(mean_squared_error(actual,baseline_pred))),"seasonal_baseline_r2":r2_score(actual,baseline_pred)})
        output["rolling_origin_validation"]={"status":"ok" if folds else "skipped","method":"expanding chronological training windows; each validation window is the next 10% of eligible rows","experiment":"B_exclude_apparent_temperature","folds":folds,
            "summary":{metric:float(np.mean([f[metric] for f in folds])) for metric in ("mae","rmse","r2","seasonal_baseline_mae","seasonal_baseline_rmse","seasonal_baseline_r2")} if folds else {},
            "limitation":"Fold scores are descriptive for this single location and archive period; they do not guarantee future performance."}
    else:
        output["rolling_origin_validation"]={"status":"skipped","reason":"Requires parseable timestamps and a successful no-apparent-temperature experiment."}
    return output


def build_report(csv_path: Path) -> dict:
    df=pd.read_csv(csv_path, low_memory=False)
    digest=hashlib.sha256()
    with csv_path.open("rb") as source:
        for block in iter(lambda: source.read(1024*1024), b""):
            digest.update(block)
    nrows,ncols=df.shape
    parsed_dates=None
    if DATE_COL in df:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            parsed_dates=pd.to_datetime(df[DATE_COL],errors="coerce",utc=True)
        if not parsed_dates.notna().any(): parsed_dates=None
    # Treat expected date strings as date-like. Other object/string columns are categorical.
    numerical=[c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    for c in df.columns:
        if c not in numerical and c != DATE_COL:
            converted=pd.to_numeric(df[c],errors="coerce")
            if converted.notna().sum() >= max(1,int(df[c].notna().sum()*.95)) and converted.notna().sum()>0:
                df[c]=converted; numerical.append(c)
    categorical=[c for c in df.columns if c not in numerical and c != DATE_COL]
    date_cols=[DATE_COL] if DATE_COL in df else []
    missing=[]
    for c in df.columns:
        miss=int(df[c].isna().sum()); missing.append({"column":c,"missing_count":miss,"missing_percentage":100*miss/max(nrows,1),"non_missing_count":nrows-miss,"data_type":str(df[c].dtype)})
    missing.sort(key=lambda x:(-x["missing_percentage"],x["column"]))
    mmat=df.isna().to_numpy()
    if nrows>MISSING_MATRIX_ROWS:
        idx=np.linspace(0,nrows-1,MISSING_MATRIX_ROWS,dtype=int)
        policy="Evenly spaced row positions, deterministic; full-column missing counts and percentages above use all rows."
    else: idx=np.arange(nrows); policy="All rows included."
    stats,hist,dist=distribution_data(df,numerical,categorical)
    kde=kde_data(df,numerical)
    corr=correlation_data(df,numerical)
    hampel=hampel_data(df,numerical,parsed_dates)
    anomaly=mahalanobis_data(df,numerical,parsed_dates)
    temporal=temporal_data(df,parsed_dates)
    model=model_data(df,numerical,categorical,parsed_dates)
    column_summary=[]
    for c in df.columns:
        column_summary.append({"name":c,"dtype":str(df[c].dtype),"non_null_count":int(df[c].notna().sum()),"unique_count":int(df[c].nunique(dropna=True)),"role":"date" if c in date_cols else "numerical" if c in numerical else "categorical"})
    overview={"row_count":nrows,"column_count":ncols,"columns":column_summary,"column_names":list(df.columns),"numerical_columns":numerical,"categorical_columns":categorical,"date_like_columns":date_cols,
        "duplicate_row_count":int(df.duplicated().sum()),"target":{"name":TARGET,"available":TARGET in df,"non_missing_count":int(df[TARGET].notna().sum()) if TARGET in df else 0},
        "dimensions_chart":{"labels":["Rows","Columns"],"values":[nrows,ncols]},"duplicate_rows_retained":True}
    missing_section={"columns":missing,"overall_missing_cells":int(mmat.sum()),"overall_missing_percentage":100*float(mmat.mean()) if mmat.size else 0.0,
        "ranked_columns":[x["column"] for x in missing],"bar_chart":{"labels":[x["column"] for x in missing],"values":[x["missing_percentage"] for x in missing],"unit":"percent"},
        "matrix":{"row_indices":idx,"columns":list(df.columns),"values":mmat[idx].astype(int),"sampled":len(idx)<nrows,"sampling_policy":policy,"original_row_count":nrows,"exported_row_count":len(idx),"encoding":"1=missing, 0=observed"}}
    return {"metadata":{"schema_version":"1.0.0","generated_at_utc":datetime.now(timezone.utc).isoformat(),"dataset_file":"weatherHistory.csv","dataset_sha256":digest.hexdigest(),
            "row_count":nrows,"column_count":ncols,"random_seed":SEED,"units":{"Temperature (C)":"degrees Celsius","Apparent Temperature (C)":"degrees Celsius","Wind Speed (km/h)":"kilometres per hour","Wind Bearing (degrees)":"degrees","Visibility (km)":"kilometres","Humidity":"fraction as encoded in source","Pressure (millibars)":"millibars"},
            "serialization":"UTF-8 strict JSON; non-finite values converted to null"},
        "dataset_overview":overview,"temporal_analysis":temporal,"missing_data":missing_section,
        "descriptive_statistics":{"numerical":stats,"categorical":dist["categorical"]},
        "distributions":{"histograms":hist,"boxplots":dist["boxplots"],"categorical_bar_charts":dist["categorical"],"violin_plot_data":"Use histogram bin centers and counts or KDE x/density; no raw observations are required."},
        "kde":kde,"correlation_analysis":corr,"noise_detection":hampel,"anomaly_detection":anomaly,"feature_importance":model,
        "chart_data":{"dataset_dimensions":overview["dimensions_chart"],"temporal":temporal,"missingness":missing_section["bar_chart"],"missingness_matrix":missing_section["matrix"],"histograms":hist,"boxplots":dist["boxplots"],"categorical":dist["categorical"],"kde":kde,
            "pearson":corr["pearson"],"spearman":corr["spearman"],"hampel":hampel["chart_data"],"mahalanobis":anomaly.get("chart_data",{}),"feature_importance":model.get("experiments",{})},
        "interpretations":{"correlation":"Associations are descriptive and do not establish causality.","hampel":"Hampel flags are statistical outliers relative to local rolling medians; they are not necessarily data errors.","mahalanobis":"Distance flags are multivariate statistical alerts under the stated normality approximation.","feature_importance":model.get("interpretation")},
        "limitations":{"warnings":[],"analyses":{"kde":{c:v.get("limitation") for c,v in kde.items() if v.get("status")!="ok"},"mahalanobis":anomaly.get("reason"),"feature_importance":model.get("reason")},
            "data_retention":"The CSV is read-only for this program. Transformations are applied to in-memory DataFrames."}}


def main() -> None:
    root=Path(__file__).resolve().parent
    csv_path=root/"datasets"/"weatherHistory.csv"
    if not csv_path.is_file():
        raise FileNotFoundError(f"Dataset not found: {csv_path}")
    report=json_safe(build_report(csv_path))
    save_report(report)
    # Validate what was actually stored in SQLite and key chart-ready invariants.
    parsed=load_report()
    for feature, record in parsed["kde"].items():
        if len(record["x"]) != len(record["density"]): raise ValueError(f"KDE array mismatch for {feature}")
    for name in ("pearson","spearman"):
        matrix=parsed["correlation_analysis"][name]["matrix"]
        if any(len(row)!=len(matrix) for row in matrix): raise ValueError(f"Invalid {name} matrix dimensions")
    print(f"Wrote and validated {DB_PATH.name}: {parsed['metadata']['row_count']} rows, {parsed['metadata']['column_count']} columns.")


if __name__ == "__main__":
    main()
