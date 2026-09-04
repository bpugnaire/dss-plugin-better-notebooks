# Better Notebooks

Better Notebooks is a Databricks-inspired notebook workspace for Dataiku. This
repository now contains both an installable Dataiku plugin webapp component and
the standalone browser prototype used to iterate on the interaction design.

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

## Install in a Dataiku development instance

1. Create or open a development plugin and copy this repository into it.
2. Reload the plugin in DSS.
3. Create a **Better Notebooks** webapp from the plugin in a project.
4. Open its settings and keep the default browser storage namespace, or set a
   unique one for an isolated prototype workspace.

The current webapp is deliberately browser-local: seeded datasets, execution,
and notebooks are illustrative. It does not yet read or modify DSS notebooks.
See [architecture](docs/architecture.md) for the next implementation phases.
