"""Read-only project context for the Better Notebooks Standard webapp.

The frontend treats this endpoint as optional so the same UI remains runnable in
a normal browser. DSS owns authentication and authorisation for this backend.
"""

import dataiku
from flask import jsonify


@app.route("/project-context", methods=["GET"])
def get_project_context():
    """Return metadata only for the current project and its visible datasets."""
    project = dataiku.api_client().get_default_project()
    summary = project.get_summary()
    datasets = []

    for dataset in project.list_datasets():
        name = dataset.get("name", "")
        if not name:
            continue
        columns = []
        try:
            columns = dataiku.Dataset(name, project_key=summary["projectKey"]).read_schema(
                raise_if_empty=False
            )
        except Exception:
            # A dataset can be visible while its schema is not readable or not
            # computed yet. The UI still exposes the dataset name safely.
            pass
        datasets.append(
            {
                "name": name,
                "type": dataset.get("type", ""),
                "columns": [
                    {"name": column.get("name", ""), "type": column.get("type", "")}
                    for column in columns
                    if column.get("name")
                ],
            }
        )

    return jsonify(
        {
            "project": {
                "key": summary["projectKey"],
                "name": summary.get("name") or summary["projectKey"],
            },
            "datasets": sorted(datasets, key=lambda item: item["name"].lower()),
        }
    )
