# Better Notebooks webapp component

This folder is the installable Dataiku Standard HTML/JavaScript webapp:

- `webapp.json` defines the Dataiku component and its settings.
- `body.html`, `style.css`, and `app.js` are the HTML, CSS, and JavaScript tabs
  of the webapp.

The UI is currently a browser-local prototype. Its configured storage namespace
keeps separate local state for each webapp configuration; it is not DSS notebook
persistence yet.
