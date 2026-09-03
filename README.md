# Better Notebooks

A standalone, browser-only prototype for a Databricks-inspired Dataiku notebook experience.

## Run locally

Open `index.html` in any modern browser. There is no build process and no Dataiku dependency.

The prototype includes local notebook persistence, cell selection and batch actions, drag reordering, Python/SQL/Markdown cell switching, simulated execution, a project dataset sidebar, and a rich sample table output.

## Planned Dataiku integration

- Persist standard Jupyter notebook content in DSS
- Execute Python through the DSS notebook kernel
- Execute `%sql` cells through DSS connections
- Replace seeded datasets with the active project datasets and schemas
- Add diagnostics, formatting, and small-model one-line completion
