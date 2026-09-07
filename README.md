# Better Notebooks

Better Notebooks is a modern notebook workspace for Dataiku. It is an
installable plugin webapp that keeps native DSS Jupyter notebooks at the
center, while providing a faster, cleaner development experience.

## What it brings

- A modern multi-notebook workspace with cell-focused editing, navigation,
  organization, keyboard shortcuts, and native DSS autosave.
- A lightweight IDE experience: CodeMirror editing, Python/SQL highlighting,
  syntax diagnostics, completion, and kernel-backed documentation hovers.
- Project-aware work: browse datasets, inspect schemas and samples, insert
  Python/SQL starter code, and see datasets linked by the current notebook.
- Real DSS execution with selectable Python environments, SQL connections,
  streamed output, interrupt support, and stop-on-error execution flow.
- Rich results for DataFrames and visualizations, including interactive
  Plotly/Vega charts and standard Jupyter image, HTML, JSON, and table output.
- A direct handoff from a DataFrame to a managed DSS dataset, including the
  explicit notebook write cell needed to materialize it.

## Repository layout

- `webapps/better-notebooks/` — the Dataiku Standard HTML/JavaScript webapp
  component (`webapp.json`, `body.html`, `style.css`, `app.js`).
- `index.html`, `styles.css`, `app.js` — standalone local preview of the same
  prototype behavior. Serve this repository locally for UI development.
- `docs/architecture.md` — integration boundary and implementation sequence.

## Run the browser preview

```bash
python3 -m http.server 4173
```

Then open `http://127.0.0.1:4173`. No build process or Dataiku instance is
needed for the current UI workflow.

## Rebuild the packaged editor

The Dataiku webapp ships its editor and rich-output renderers bundled directly
into the checked-in `webapps/better-notebooks/app.js`, so DSS never needs a
CDN. The editable application source is `webapps/better-notebooks/app-runtime.js`.
After editing it or its supporting modules, run:

```bash
pnpm install
pnpm run build:webapp
```

## Install in a Dataiku development instance

1. Create or open a development plugin and copy this repository into it.
2. Reload the plugin in DSS.
3. Create a **Better Notebooks** webapp from the plugin in a project.
4. Open its settings and keep the default browser storage namespace, or set a
   unique one for an isolated prototype workspace.

Inside DSS, Better Notebooks reads the native Jupyter notebooks available in
the project. Edits to cells, Markdown, cell ordering, and the selected Python
environment autosave back to the same native DSS notebook. Creating, copying,
renaming, and deleting a notebook also operate on native DSS notebooks. The
left-hand folder tree stays browser-local by design: DSS has no notebook-folder
structure to mirror.

Inside DSS, cell execution connects to the notebook’s actual Jupyter kernel,
and its resulting outputs are persisted back to the native notebook.
