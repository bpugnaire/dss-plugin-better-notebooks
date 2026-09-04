"""DSS project context and native notebook storage adapters."""

import ast
import json
import re

import dataiku
from flask import jsonify, request


NOTEBOOK_NAME = re.compile(r"^[\w .-]{1,100}$", re.UNICODE)
MAX_CHECK_SOURCE_LENGTH = 200_000


def current_project():
    return dataiku.api_client().get_default_project()


def available_runtimes():
    """Map available Python code environments to DSS Jupyter kernel specs."""
    runtimes = [{
        "id": "dss_builtin",
        "label": "DSS built-in Python",
        "kernelSpec": {"name": "python3", "display_name": "DSS built-in Python", "language": "python"},
    }]
    try:
        code_envs = dataiku.api_client().list_code_envs()
    except Exception:
        # A restricted user can still work with the built-in DSS kernel.
        code_envs = []
    for env in code_envs:
        language = env.get("envLang") or env.get("language")
        name = env.get("envName") or env.get("name")
        if language == "PYTHON" and name:
            runtimes.append({
                "id": name,
                "label": name,
                "kernelSpec": {
                    "name": "py-dku-venv-%s" % name,
                    "display_name": "DSS Code env - %s" % name,
                    "language": "python",
                },
            })
    return runtimes


def runtime_for(runtime_id):
    return next((item for item in available_runtimes() if item["id"] == runtime_id), None)


def empty_notebook(kernel_spec):
    return {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"kernelspec": kernel_spec, "language_info": {"name": "python"}},
        "cells": [{
            "cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": [],
        }],
    }


@app.route("/project-context", methods=["GET"])
def get_project_context():
    """Return metadata only for the current project and its visible datasets."""
    project = current_project()
    summary = project.get_summary()
    datasets = []
    connections = []
    connection_names = set()

    def add_connection(name, connection_type="SQL"):
        if name and name not in connection_names:
            connection_names.add(name)
            connections.append({"name": name, "type": connection_type or "SQL"})

    for dataset in project.list_datasets():
        name = dataset.get("name", "")
        if not name:
            continue
        columns = []
        connection = ""
        table_name = ""
        try:
            columns = dataiku.Dataset(name, project_key=summary["projectKey"]).read_schema(
                raise_if_empty=False
            )
        except Exception:
            pass
        datasets.append({
            "name": name,
            "type": dataset.get("type", ""),
            "connection": connection,
            "tableName": table_name,
            "columns": [
                {"name": column.get("name", ""), "type": column.get("type", "")}
                for column in columns if column.get("name")
            ],
        })
        # A user can be allowed to use a dataset's connection while lacking
        # permission to list every instance connection. Infer those useful
        # connections directly from project dataset settings as well.
        try:
            raw_settings = project.get_dataset(name).get_settings().get_raw()
            connection = raw_settings.get("params", {}).get("connection", "")
            datasets[-1]["connection"] = connection
            add_connection(connection, dataset.get("type"))
        except Exception:
            pass
        try:
            location = dataiku.Dataset(name, project_key=summary["projectKey"]).get_location_info().get("info", {})
            table_name = location.get("quotedResolvedTableName") or location.get("table") or ""
            datasets[-1]["tableName"] = table_name
        except Exception:
            pass
    try:
        raw_connections = dataiku.api_client().list_connections()
        for connection in raw_connections.values() if isinstance(raw_connections, dict) else raw_connections:
            if isinstance(connection, str):
                add_connection(connection)
                continue
            name = connection.get("name") or connection.get("connectionName")
            add_connection(name, connection.get("type") or connection.get("connectionType") or "SQL")
    except Exception:
        # Connection discovery can be restricted independently from dataset access.
        pass
    # This built-in DSS connection is present on local installations and is
    # intended for project-managed files. It is not always returned by the
    # connection-list API for non-admin users.
    add_connection("filesystem_managed", "Filesystem")
    return jsonify({
        "project": {"key": summary["projectKey"], "name": summary.get("name") or summary["projectKey"]},
        "datasets": sorted(datasets, key=lambda item: item["name"].lower()),
        "connections": sorted(connections, key=lambda item: item["name"].lower()),
    })


@app.route("/datasets/<path:dataset_name>/preview", methods=["GET"])
def preview_dataset(dataset_name):
    """Return a small, JSON-safe preview for the interactive dataset inspector."""
    project = current_project()
    summary = project.get_summary()
    try:
        frame = dataiku.Dataset(dataset_name, project_key=summary["projectKey"]).get_dataframe(limit=20)
        preview = json.loads(frame.to_json(orient="split", date_format="iso", default_handler=str))
        return jsonify({"columns": preview.get("columns", []), "rows": preview.get("data", []), "rowCount": len(frame.index)})
    except Exception as error:
        return jsonify({"error": "Could not preview this dataset: %s" % error}), 400


@app.route("/notebooks", methods=["GET"])
def list_notebooks():
    notebooks = [{
        "name": item.name,
        "language": item.language,
        "kernelSpec": item.kernel_spec,
    } for item in current_project().list_jupyter_notebooks(as_type="listitems")]
    return jsonify({"notebooks": sorted(notebooks, key=lambda item: item["name"].lower())})


@app.route("/notebooks/<path:notebook_name>", methods=["GET"])
def get_notebook(notebook_name):
    content = current_project().get_jupyter_notebook(notebook_name).get_content().get_raw()
    return jsonify({"notebook": content})


@app.route("/notebooks", methods=["POST"])
def create_notebook():
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name", "")).strip()
    if not NOTEBOOK_NAME.match(name):
        return jsonify({"error": "Notebook names may contain letters, numbers, spaces, dots, dashes, and underscores."}), 400
    runtime = runtime_for(payload.get("runtimeId", "dss_builtin"))
    if runtime is None:
        return jsonify({"error": "The selected Python runtime is not available."}), 400
    project = current_project()
    project.create_jupyter_notebook(name, empty_notebook(runtime["kernelSpec"]))
    return jsonify({"notebook": project.get_jupyter_notebook(name).get_content().get_raw()}), 201


@app.route("/notebooks/<path:notebook_name>", methods=["PUT"])
def save_notebook(notebook_name):
    """Persist an edited native notebook, preserving its nbformat document."""
    payload = request.get_json(force=True) or {}
    content = payload.get("notebook")
    if not isinstance(content, dict) or not isinstance(content.get("cells"), list):
        return jsonify({"error": "A valid Jupyter notebook document is required."}), 400
    notebook_content = current_project().get_jupyter_notebook(notebook_name).get_content()
    notebook_content.content = content
    notebook_content.save()
    return jsonify({"notebook": notebook_content.get_raw()})


@app.route("/notebooks/<path:notebook_name>/rename", methods=["POST"])
def rename_notebook(notebook_name):
    """Rename by copy/delete; DSS has no native Jupyter-notebook rename endpoint."""
    payload = request.get_json(force=True) or {}
    next_name = str(payload.get("name", "")).strip()
    if not NOTEBOOK_NAME.match(next_name):
        return jsonify({"error": "Notebook names may contain letters, numbers, spaces, dots, dashes, and underscores."}), 400
    if next_name == notebook_name:
        return jsonify({"name": notebook_name})
    project = current_project()
    source = project.get_jupyter_notebook(notebook_name)
    content = source.get_content().get_raw()
    project.create_jupyter_notebook(next_name, content)
    source.delete()
    return jsonify({"name": next_name})


@app.route("/notebooks/<path:notebook_name>/copy", methods=["POST"])
def copy_notebook(notebook_name):
    """Copy a native notebook without turning it into a browser-only draft."""
    payload = request.get_json(force=True) or {}
    next_name = str(payload.get("name", "")).strip()
    if not NOTEBOOK_NAME.match(next_name):
        return jsonify({"error": "Notebook names may contain letters, numbers, spaces, dots, dashes, and underscores."}), 400
    project = current_project()
    content = project.get_jupyter_notebook(notebook_name).get_content().get_raw()
    project.create_jupyter_notebook(next_name, content)
    return jsonify({"notebook": project.get_jupyter_notebook(next_name).get_content().get_raw()}), 201


@app.route("/notebooks/<path:notebook_name>", methods=["DELETE"])
def delete_notebook(notebook_name):
    current_project().get_jupyter_notebook(notebook_name).delete()
    return jsonify({"deleted": notebook_name})


@app.route("/python-check", methods=["POST"])
def check_python():
    """Return a safe, non-executing Python syntax diagnostic for one cell."""
    source = str((request.get_json(force=True) or {}).get("source", ""))
    if len(source) > MAX_CHECK_SOURCE_LENGTH:
        return jsonify({"valid": False, "message": "Cell is too large to check.", "line": None, "column": None}), 400
    try:
        ast.parse(source)
    except SyntaxError as error:
        return jsonify({
            "valid": False,
            "message": error.msg,
            "line": error.lineno,
            "column": error.offset,
        })
    return jsonify({"valid": True})


@app.route("/python-runtimes", methods=["GET"])
def list_python_runtimes():
    return jsonify({"runtimes": available_runtimes()})


@app.route("/datasets", methods=["POST"])
def create_managed_dataset():
    """Create a DSS managed dataset for an explicit DataFrame write cell."""
    payload = request.get_json(force=True) or {}
    name = str(payload.get("name", "")).strip()
    connection = str(payload.get("connection", "")).strip()
    if not NOTEBOOK_NAME.match(name):
        return jsonify({"error": "Dataset names may contain letters, numbers, spaces, dots, dashes, and underscores."}), 400
    if not connection:
        connection = "filesystem_managed"
    try:
        builder = current_project().new_managed_dataset(name)
        builder.with_store_into(connection)
        builder.create()
    except Exception as error:
        return jsonify({"error": "Could not create the managed dataset: %s" % error}), 400
    return jsonify({"dataset": {"name": name, "connection": connection}}), 201
