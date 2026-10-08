# Architecture

Better Notebooks is a standard Dataiku HTML/JavaScript plugin webapp. Its native
mode reads and writes project Jupyter notebook documents through the Python
backend and connects directly to DSS's same-origin Jupyter HTTP/WebSocket
transport. The frontend has no server credentials in browser storage.

## Responsibilities

- `app-runtime.js` orchestrates notebook navigation, editing and UI actions.
- The save coordinator owns per-notebook debounce, single-flight requests,
  revision tracking and generation-safe acknowledgement. The backend checks
  revisions under a per-project/notebook process lock.
- The session registry owns native session discovery, socket routing, pending
  requests, display updates, probing, reconnect and invalidation.
- The execution queue serializes requests per notebook and cancels pending work
  on interrupt, failure or uncertain completion. Different notebooks can run
  concurrently.
- The result explorer owns bounded structured descriptors, kernel snapshots and
  per-result table/chart/profile settings. Its silent queries use the execution
  queue, with failures contained so they cannot cancel user cells.
- Document serialization preserves the native nbformat fields and cell IDs.
  Recovery storage is browser-local, scoped to project, webapp and notebook.

The project-context endpoint returns project and dataset metadata; preview rows
are obtained separately. SQL executes using a selected connection through
`SQLExecutor2`. AI assistance uses the project's configured LLM Mesh models.
Folder organization and open-tab metadata remain local display preferences;
DSS has no notebook-folder tree to mirror.

## Failure boundaries

Async execution and persistence carry their originating notebook rather than
consulting the currently selected tab. A finished save only clears the recovery
draft if it acknowledges every local edit. Conflicts suspend further automatic
writes. Disconnections preserve partial output and never replay code.

Native rename is a copy/delete operation; deleting the source stops its native
sessions. Runtime changes stop the existing session and create a fresh notebook session
with the requested kernelspec, keeping launch context on the DSS session path. These operations wait for saves and refuse
unresolved execution or recovery states.

The backend cannot provide atomic compare-and-swap across native DSS editors
or other backend processes. Session paths, permissions, kernelspec discovery,
XSRF and WebSocket behavior must be checked on an identified DSS deployment.
See [reliability delivery and acceptance recipe](reliability.md).

## Build and verification

Python hover help reads signatures, docstrings, imports and selected inferred
types from the current cell and preceding Python cells. It can show notebook
definitions and common pandas/Dataiku help before execution, without starting
a kernel. An already connected idle kernel can still supply richer runtime
documentation. Unknown imported members show their import path; dynamic object
details require execution.

Editable source and local modules are bundled into the checked-in webapp
`app.js` using `pnpm run build:webapp`. `pnpm test` runs local checks only and
verifies that the shipped bundle matches the source. Browser tests are a
separate opt-in command; DSS acceptance remains the publication gate.

## Structured results

The embedded Python formatter and explorer lifecycle are described in
[the result explorer guide](result-explorer.md), including limits and manual DSS
acceptance with a user-provided million-row dataset. The native HTML fallback is
a historical preview; complete exploration uses the structured MIME payload.
