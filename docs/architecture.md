# Architecture and delivery path

## What this component is today

`webapps/better-notebooks` is a standard Dataiku HTML/JavaScript webapp component.
It is intentionally self-contained: the same browser-first UI can be evaluated
locally before it is installed in DSS. In browser preview the app uses
`localStorage` for the prototype notebooks. Inside DSS, the project notebook
list and notebook contents come from the native Jupyter notebook APIs; only
open-tab state and display-only folders remain browser-local.

The component is an instantiable project webapp, rather than an override of the
native DSS notebook editor. It reads and writes the same native Jupyter notebook
documents: cell changes, Markdown, reordering, and selected kernel metadata
round-trip to DSS. Create, copy, and delete use their matching native actions.
Rename is implemented as an explicit copy/delete operation because DSS exposes
no native rename endpoint; it warns the user and stops any active session for
the old name. The project endpoint returns metadata only—dataset rows are never
returned by this endpoint.

## Runtime boundary

The frontend reads the webapp configuration through `dataiku.getWebAppConfig()`
when that API is available. Nothing else in the UI should directly depend on a
Dataiku transport API. Future integration code belongs behind the following
interfaces:

| Capability | Adapter responsibility | First validation |
| --- | --- | --- |
| Project datasets | List datasets and schemas; insert safe loading snippets | Read-only project API call |
| Notebook storage | Read/write native Jupyter documents | Round-trip one sample notebook |
| Python execution | Submit a cell to the supported DSS execution surface and return stdout/results | Execute `1 + 1` |
| SQL execution | Submit SQL with an explicitly selected connection/warehouse | Execute `SELECT 1` |
| AI completion | Send only the current line and intended language to an approved model endpoint | One-line completion, opt-in |

Each adapter must enforce project permissions and return structured errors that
the UI can display. Credentials, warehouse settings, and model keys must never
be stored in browser storage.

## Delivery phases

1. Install this webapp component in a development DSS instance and validate the
   native read/write round trip against a disposable notebook.
2. Prove one supported Python execution path through DSS. This must create or
   attach to a real native kernel and return structured stdout, errors, and
   table results; the present Run control intentionally does not fake this.
3. Add an explicit SQL connection/warehouse selector, then prove `SELECT 1`
   through a supported SQL execution surface.
4. Replace static output placeholders with normalized execution results and a
   table explorer.
5. Add semantic Python/SQL diagnostics, one-line completion, and a test matrix
   across supported DSS versions.
