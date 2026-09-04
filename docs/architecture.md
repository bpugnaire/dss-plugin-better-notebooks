# Architecture and delivery path

## What this component is today

`webapps/better-notebooks` is a standard Dataiku HTML/JavaScript webapp component.
It is intentionally self-contained: the same browser-first UI can be evaluated
locally before it is installed in DSS. The app uses `localStorage` only for its
prototype notebooks, open tabs, and display-only folders.

The current component does **not** replace Dataiku's native notebook editor. It
is an instantiable project webapp, which is the safe first integration point for
validating the interaction model and project context. Its first backend endpoint
is read-only and returns the current project name/key plus the names, types, and
schemas of visible datasets; local browser preview continues to use seeded
example datasets. Dataset rows are never returned by this endpoint.

## Runtime boundary

The frontend reads the webapp configuration through `dataiku.getWebAppConfig()`
when that API is available. Nothing else in the UI should directly depend on a
Dataiku transport API. Future integration code belongs behind the following
interfaces:

| Capability | Adapter responsibility | First validation |
| --- | --- | --- |
| Project datasets | List datasets and schemas; insert safe loading snippets | Read-only project API call |
| Notebook storage | Read/write a compatible notebook representation | Round-trip one sample notebook |
| Python execution | Submit a cell to the supported DSS execution surface and return stdout/results | Execute `1 + 1` |
| SQL execution | Submit SQL with an explicitly selected connection/warehouse | Execute `SELECT 1` |
| AI completion | Send only the current line and intended language to an approved model endpoint | One-line completion, opt-in |

Each adapter must enforce project permissions and return structured errors that
the UI can display. Credentials, warehouse settings, and model keys must never
be stored in browser storage.

## Delivery phases

1. Install this webapp component in a development DSS instance and validate the
   shell, Dataiku sizing, and project-level access.
2. Extend the read-only project-context adapter with schemas and dataset
   permissions as needed.
3. Prove one supported Python and one supported SQL execution path before
   designing a notebook persistence format.
4. Replace seeded outputs with normalized execution results, starting with
   tabular output.
5. Add persistence, completion, diagnostics, and a test matrix across supported
   DSS versions.
