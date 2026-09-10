"""DSS project context and native notebook storage adapters."""

import ast
import json
import re

import dataiku
from flask import Response, jsonify, request, stream_with_context


NOTEBOOK_NAME = re.compile(r"^[\w .-]{1,100}$", re.UNICODE)
MAX_CHECK_SOURCE_LENGTH = 200_000
MAX_AI_SOURCE_LENGTH = 100_000
MAX_AI_QUESTION_LENGTH = 10_000


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


def available_llms():
    """List text-generation models the current project user can actually use."""
    try:
        all_models = current_project().list_llms()
        try:
            # Dataiku calls chat/code-capable models GENERIC_COMPLETION. The
            # similarly named TEXT_GENERATION value is not a valid purpose.
            models = current_project().list_llms(purpose="GENERIC_COMPLETION") or all_models
        except TypeError:
            # DSS versions prior to the purpose selector are still supported.
            models = all_models
    except Exception:
        return []
    result = []
    for model in models:
        model_id = getattr(model, "id", None) or (model.get("id") if isinstance(model, dict) else None)
        description = getattr(model, "description", None) or (model.get("description") if isinstance(model, dict) else None)
        if model_id:
            result.append({"id": str(model_id), "label": str(description or model_id)})
    return result


def llm_error_message(response):
    """Extract a useful DSS/provider failure reason without leaking internals."""
    for attribute in ("message", "error", "error_message", "reason"):
        value = getattr(response, attribute, None)
        if value:
            return str(value)
    raw = getattr(response, "raw_resp", None) or getattr(response, "data", None)
    if isinstance(raw, dict):
        for key in ("message", "error", "errorMessage", "reason"):
            if raw.get(key):
                return str(raw[key])
    return "LLM Mesh did not complete the request. Check that the selected model is configured and that you have Use permission."


def prepare_ai_completion(payload):
    """Validate a focused coding request and build its LLM Mesh completion."""
    cell = payload.get("cell") or {}
    source = str(cell.get("source") or "")
    question = str(payload.get("question") or "Explain this cell and suggest an improvement.").strip()
    language = str(cell.get("language") or "python").strip().lower()
    notebook_name = str(payload.get("notebookName") or "this notebook").strip()
    error = str(payload.get("error") or "").strip()
    mode = str(payload.get("mode") or "answer").strip().lower()
    if len(source) > MAX_AI_SOURCE_LENGTH or len(question) > MAX_AI_QUESTION_LENGTH:
        raise ValueError("The cell or question is too large for AI assistance.")
    models = available_llms()
    if not models:
        raise ValueError("No LLM Mesh text-generation model is available to this project user.")
    requested_id = str(payload.get("modelId") or configured_coding_llm_id() or models[0]["id"])
    if not any(model["id"] == requested_id for model in models):
        raise ValueError("The selected LLM Mesh model is not available in this project.")
    system_prompt = (
        "You are a concise Dataiku notebook coding assistant. Help with the provided single cell only. "
        "Do not claim to have executed code. Explain risks clearly, preserve Dataiku conventions, and return "
        "Markdown with a suggested replacement only when it materially helps."
    )
    if mode == "rewrite":
        system_prompt = (
            "You are a Dataiku notebook coding assistant. Rewrite the supplied single cell to satisfy the request. "
            "Return only the complete replacement source code for that cell: no Markdown fences, explanation, or preamble. "
            "Preserve Dataiku conventions and do not claim that code has run."
        )
    user_prompt = "\n\n".join([
        "Notebook: %s" % notebook_name,
        "Cell language: %s" % language,
        "User request: %s" % question,
        "Cell source:\n```%s\n%s\n```" % (language, source),
        ("Observed error:\n%s" % error) if error else "",
    ]).strip()
    completion = current_project().get_llm(requested_id).new_completion()
    completion.with_message(system_prompt, role="system")
    completion.with_message(user_prompt, role="user")
    # Do not force a temperature: newer reasoning models and some managed
    # OpenAI deployments reject it. Leaving it unset uses the model default.
    completion.settings["maxOutputTokens"] = 900
    return requested_id, completion


def configured_coding_llm_id():
    try:
        return str(dataiku.get_webapp_config().get("coding_llm_id") or "").strip()
    except Exception:
        return ""


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


@app.route("/llm-models", methods=["GET"])
def list_llm_models():
    models = available_llms()
    configured = configured_coding_llm_id()
    default_id = configured if any(model["id"] == configured for model in models) else (models[0]["id"] if models else "")
    return jsonify({"models": models, "defaultModelId": default_id})


@app.route("/ai-help", methods=["POST"])
def ask_ai_for_cell_help():
    """Ask an authorized LLM Mesh model for focused, non-executing cell help."""
    payload = request.get_json(force=True) or {}
    try:
        requested_id, completion = prepare_ai_completion(payload)
        response = completion.execute()
        if not getattr(response, "success", False):
            return jsonify({"error": llm_error_message(response)}), 502
        return jsonify({"modelId": requested_id, "response": response.text})
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        return jsonify({"error": "LLM Mesh request failed: %s" % error}), 502


@app.route("/ai-help/stream", methods=["POST"])
def stream_ai_for_cell_help():
    """Relay LLM Mesh streamed chunks to the webapp as server-sent events."""
    payload = request.get_json(force=True) or {}
    try:
        requested_id, completion = prepare_ai_completion(payload)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except Exception as error:
        return jsonify({"error": "LLM Mesh request could not be prepared: %s" % error}), 502

    def event(name, data):
        return "event: %s\ndata: %s\n\n" % (name, json.dumps(data))

    @stream_with_context
    def generate():
        try:
            streamer = completion.execute_streamed(collect_response=True)
            chunks = streamer.iter_chunks() if hasattr(streamer, "iter_chunks") else streamer
            for chunk in chunks:
                data = getattr(chunk, "data", {}) or {}
                text = data.get("text", "") if isinstance(data, dict) else ""
                if text:
                    yield event("delta", {"text": str(text)})
            response = getattr(streamer, "response", None)
            if response is not None and not getattr(response, "success", False):
                yield event("error", {"error": llm_error_message(response)})
            else:
                yield event("done", {"modelId": requested_id})
        except Exception as error:
            yield event("error", {"error": "LLM Mesh request failed: %s" % error})

    return Response(generate(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


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
