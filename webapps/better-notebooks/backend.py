"""Read-only DSS context plus native notebook discovery and creation."""

import re

import dataiku
from flask import jsonify, request


NOTEBOOK_NAME = re.compile(r"^[\w .-]{1,100}$", re.UNICODE)


def current_project():
    return dataiku.api_client().get_default_project()


def available_runtimes():
    """Map available Python code environments to DSS Jupyter kernel specs."""
    runtimes = [{
        "id": "dss_builtin",
        "label": "DSS built-in Python",
        "kernelSpec": {"name": "python3", "display_name": "DSS built-in Python", "language": "python"},
    }]
    for env in dataiku.api_client().list_code_envs():
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
            pass
        datasets.append({
            "name": name,
            "type": dataset.get("type", ""),
            "columns": [
                {"name": column.get("name", ""), "type": column.get("type", "")}
                for column in columns if column.get("name")
            ],
        })
    return jsonify({
        "project": {"key": summary["projectKey"], "name": summary.get("name") or summary["projectKey"]},
        "datasets": sorted(datasets, key=lambda item: item["name"].lower()),
    })


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


@app.route("/python-runtimes", methods=["GET"])
def list_python_runtimes():
    return jsonify({"runtimes": available_runtimes()})
