# Structured result explorer

The installable webapp now renders pandas DataFrames as Table / Graphique / Profil.
Python final expressions, explicit `display(df)` calls and SQL results share the same
explorer. It operates on the object actually displayed: `df.head()` exposes five
rows, while `df` exposes the complete frame. SQL still uses `query_to_df`; it
materializes the query in the notebook kernel and does not paginate the database.
Spark, Polars and multiple charts per result are outside this version.

## Implementation and persistence

The build embeds `modules/result-explorer.py` as text. The normal execution
bootstrap installs its IPython formatter once, alongside matplotlib setup, under
`application/vnd.better-notebooks.table.v1+json`. It retains native representations
for compatibility with other notebook editors. `_bn_explorer` is reserved in the
Python namespace. Unsupported Python environments retain their native outputs.

The descriptor includes a kernel generation, snapshot ID, positional column IDs,
labels, pandas/logical types, index metadata, total rows and a bounded preview.
JSON tags preserve large integers, decimals, dates, tuples and nonfinite floats;
missing values are `null`, distinct from empty strings. Nested/custom objects are
frozen as text and mixed object columns have limited profiling support.

Page/filter/sort/chart/profile/export operations use silent Jupyter executions
with an empty code field and a fixed `user_expressions` helper call containing
base64 JSON. The dispatcher validates operations and column identifiers; it does
not evaluate user filters as Python or SQL. Responses require reply plus idle.
Queries share the per-notebook queue but their failures do not cancel queued cells.
Obsolete responses cannot update a newer result or filter configuration.

The frontend owns one model per notebook, cell and tabular result ordinal. Inline
and expanded views share that model. `cell.metadata.betterNotebooks.resultExplorer`
stores versioned filters, sorts, hidden columns, chart settings, selected tab and
bounded chart/profile results. Native notebook saves, recovery drafts and `.ipynb`
exports carry this metadata. Full pages and full snapshots are not persisted.
On reexecution, referenced columns must keep their positional ID, label and logical
type. Incompatible schemas require Reset rather than silently choosing new columns.
Saved chart/profile source IDs prevent reusing an earlier computation as a current
result after reexecution.

Reopening can attach to an existing compatible DSS session without starting a new
kernel. If none exists, the saved preview and last computed chart/profile remain
readable. Check snapshot retries availability without replaying notebook code.
Reexecution, output clearing, display replacement, deletion and kernel restart
invalidate the affected live references; expiration is checked on kernel requests.
Copied cells do not share mutable visualization settings, and snapshots still
referenced by another cell are retained.

## Controls and limits

- Pagination: 100 rows by default; 50, 100 or 500 per requested page. Transfers are
  byte-bounded, so a wide result may return fewer rows with a correct continuation.
- Filters combine with AND. Numeric/date columns support equality, inequalities
  and intervals; text supports case-insensitive contains/equality; booleans accept
  true/false; all columns support null/not-null. Nulls sort last in both directions.
  Shift-click adds or changes a sort while preserving its priority.
- CSV exports all filtered/sorted rows, independently of pagination, using visible
  or all columns. UTF-8 CSV chunks are at most 256 KiB and 1,000 rows. An oversized
  row, cancelled export or exceeded browser budget fails before any file downloads.
- Charts: bar/line/scatter/histogram, axes, grouping series, title and count/sum/
  mean/min/max. Histograms count all finite numeric values; scatter uses an
  explicitly labeled deterministic sample of at most 5,000 rows. More than 1,000
  aggregated groups/series requires a filter instead of silently dropping groups.
- Profile uses all filtered rows. Missing counts/percentages, non-null cardinality,
  statistics, numeric/date histograms and top-20 categorical values are computed
  in Python. Numeric summaries use pandas floating-point statistics; nonfinite
  values are excluded from distributions/mean/quantiles/std. Min/max retain their
  typed representation. Distribution sampling is not used.
- Preview: at most 100 rows / 1 MiB. Chart and profile replies are bounded to 1 MiB;
  an oversized chart is refused, and a partial column profile is labeled truncated.
- Defaults configurable in webapp settings: 128 MiB per snapshot, 256 MiB per
  kernel, 30 minutes inactivity, 100 MiB browser CSV. Least recently used snapshots
  are evicted. Descriptor/profile cache estimates count toward the snapshot budget;
  at most 64 snapshots, 3 cached profiles per snapshot and 4 concurrent exports.

These memory limits are estimates for retained explorer state. The original
DataFrame, temporary filtering/sorting/aggregation buffers, native pandas output
and CSV cursor positions consume additional kernel memory. Pandas display options
still control the size of the complementary native HTML/text representations.
No durable full-result storage or SQL pushdown is added. Large object cells that
cannot fit in a page/CSV chunk require reducing the displayed frame in Python.

## Local verification

Install test dependencies into an isolated environment, then run without a browser:

```sh
uv venv .venv
uv pip install --python .venv/bin/python -r tests/requirements.txt
pnpm run build:webapp
BETTER_NOTEBOOKS_TEST_PYTHON=.venv/bin/python pnpm test
```

Python tests cover real IPython final-expression and display formatting, snapshots,
large integers, nulls, duplicate/MultiIndex columns, filters/sorts, charts, profiles,
CSV, budgets/eviction and a synthetic million-row frame. JavaScript tests cover the
transport, state ownership, stale responses, reexecution, export failure, metadata
persistence and existing reliability behavior. The test runner verifies that the
checked-in bundle exactly matches a build from source.

Browser specs are provided as an opt-in regression suite. They have not been
validated for this delivery: browser execution was stopped at the user's request.
Visual and manual DSS integration acceptance belong to the user.

## Manual DSS acceptance — user-provided million-row dataset

Install/reload the modified plugin and reload its webapp. Use your own million-row
dataset; no dataset is created by this change. Ensure the selected notebook Python
environment provides pandas, NumPy and IPython.

```python
import dataiku
import pandas as pd

df = dataiku.Dataset("YOUR_MILLION_ROW_DATASET").get_dataframe()
assert len(df) == 1_000_000
# Display the complete object, rather than its head.
df
```

1. Check the total count, types, null display and explicit truncation of the saved
   preview. Move beyond the first page. Compare selected rows with pandas. If the
   snapshot exceeds 128 MiB, check the budget message; raise the configured budget
   only for a kernel with sufficient memory, or display a smaller set of columns.
2. Apply a filter matching rows late in the frame. Verify the filtered count against
   pandas, add two sort keys, and confirm nulls stay last. Hide a column, open Expand,
   and verify both views stay synchronized, including filter and sort state.
3. Export visible columns and then all columns. Verify row count and ordering against
   the filtered pandas frame, including quoted strings and newlines. Exercise a
   deliberately small CSV limit and verify no partial file is downloaded.
4. Build a grouped count and numeric sum/mean; compare with pandas groupby. Test a
   numeric histogram and scatter sampling label. A high-cardinality grouping must
   request a filter rather than present a silently reduced chart.
5. Open Profil. Compare missing counts, `nunique`, `describe` and `value_counts` with
   pandas over the same filtered rows. Check nullable numeric/string, decimal, date,
   timezone, duplicate-column and MultiIndex examples on small controlled frames.
6. Mutate `df` after displaying it. The earlier result must retain its original
   values. Reexecute the display cell; the new snapshot must reflect the mutation
   and recompute chart/profile data while retaining valid visualization settings.
7. Save/reload and export/reimport `.ipynb`. Check retained filters, chart settings,
   chart and profile. With the kernel stopped, only historical summaries are
   available. With the same kernel still alive, Check snapshot can restore access.
8. Exercise `display(df)` twice, mixed text/image/Plotly outputs, SQL output,
   `clear_output` and `display_id` updates. Every table must have independent settings.
9. Switch notebooks while a profile is computing; verify ownership. Interrupt a
   calculation, disconnect/reconnect and restart the kernel. No notebook code should
   be replayed by exploration, and obsolete snapshots must be identified.
10. Inspect network payload sizes and kernel/browser memory for a million-row and a
    wide frame. Record capture, page/filter, chart and profile durations on your DSS
    deployment; local synthetic timings are not DSS performance acceptance.
