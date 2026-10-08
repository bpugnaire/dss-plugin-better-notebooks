# Better Notebooks webapp

This is the installable Dataiku Standard HTML/JavaScript webapp. Its frontend
reads and saves native project notebooks through `backend.py`, while execution
uses the notebook's actual DSS Jupyter session. Browser preview remains local
and shows illustrative results.

Edit `app-runtime.js` and its modules, then run `pnpm run build:webapp` from the
repository root to regenerate the delivered `app.js`. Keep the backend and
frontend on the same revision and reload old open tabs after upgrading.

For local verification and the required DSS publication checks, see
[the reliability delivery guide](../../docs/reliability.md).
