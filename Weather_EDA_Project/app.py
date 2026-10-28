"""Flask dashboard for the weather EDA report stored in SQLite."""
from __future__ import annotations

from flask import Flask, jsonify, render_template, request

from database import get_dataset, list_datasets, list_descriptions, load_report, set_description

app = Flask(__name__)


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


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=False)
