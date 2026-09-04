"""Read-only project context for the Better Notebooks Standard webapp.

The frontend treats this endpoint as optional so the same UI remains runnable in
a normal browser. DSS owns authentication and authorisation for this backend.
"""

import dataiku
from flask import jsonify


@app.route("/project-context/datasets", methods=["GET"])
def list_project_datasets():
    """Return lightweight metadata for datasets visible in the current project."""
    project = dataiku.api_client().get_default_project()
    datasets = project.list_datasets()
    payload = [
        {
            "name": dataset.get("name", ""),
            "type": dataset.get("type", ""),
        }
        for dataset in datasets
        if dataset.get("name")
    ]
    return jsonify({"datasets": sorted(payload, key=lambda item: item["name"].lower())})
