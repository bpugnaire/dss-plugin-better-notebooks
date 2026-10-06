# Reliability delivery

## Verification and release gate

Local verification uses Node tests, a simulated DSS API for the actual Flask
routes, and an in-memory rebuild to check the shipped bundle. It does not start
a browser or require a DSS instance.

```bash
pnpm install --frozen-lockfile
python3 -m venv .venv
.venv/bin/python -m pip install -r tests/requirements.txt
pnpm run build:webapp
BETTER_NOTEBOOKS_TEST_PYTHON=.venv/bin/python pnpm test
```

`BETTER_NOTEBOOKS_TEST_PYTHON` is optional when the default `python3` already has
Flask. Build output is checked in; tests report a stale bundle without rewriting
it. The browser suite is **opt-in**, separate from `pnpm test`, and was not
executed for this delivery. To run it later, with explicit authorization:

```bash
pnpm exec playwright install chromium
pnpm run test:browser
```

The browser tests use the delivered HTML and bundle with simulated HTTP and
WebSocket transports. They do not connect to DSS. Local tests are not proof of
compatibility with any specific DSS version.

Do not publish until the DSS acceptance recipe below has passed on an
identified version. Reload the backend and frontend together; older open tabs
must refresh, because writes without a revision now receive HTTP 428.

## Persistence contract

Read, create, copy and successful save responses contain `notebook` and
`revision`. The revision is SHA-256 of sorted-key, compact, UTF-8 JSON. A save
contains the full native notebook and `expectedRevision`.
After saving, the backend reads the notebook again from DSS before returning
its document and revision. This accounts for server-side normalization that
does not update the SDK object's local content, avoiding conflicts on the
next save caused by the plugin's own write.

- Missing revision: HTTP 428, `REVISION_REQUIRED`.
- Changed document: HTTP 409, `NOTEBOOK_CONFLICT`, current `revision`; no write.
- The exact requested document is already current: acknowledge it without
  rewriting, even if the expected revision is old (lost-response retry).
- Otherwise compare and write under a lock keyed by project and notebook.

The lock serializes only requests handled by the same backend process. It
cannot make DSS native-editor writes, another webapp backend, or another worker
participate in an atomic transaction. A very narrow read/write race with those
writers remains possible. No distributed lock or coediting guarantee is made.

The frontend has a separate 650 ms debounce, generation counter, error state,
and single-flight writer for every notebook. New edits during a request remain
in the recovery draft and are saved in the next request. Background completion
never replaces the active notebook. A conflict suspends autosave; the dialog
can load DSS after explicit discard confirmation, export the local document,
or save it as a new native notebook.
Cell comparisons identify source, type, collapsed state, outputs and execution
state differences, so identical source text is not presented as a code change.

Recovery keys include project, webapp backend path (or explicit `webapp_id`),
notebook identity and configured namespace. Legacy unscoped drafts are offered
as candidates rather than automatically applied; their origin cannot be
verified. Restoring one preserves the legacy copy and records its acknowledgement after a successful DSS save, so it is not offered again. Choosing to discard it
explicitly removes it. Recovery comparison includes outputs and execution state, even when source code is unchanged. Storage access failures show a persistent warning but
leave native editing and saving available. Recovery decisions suspend autosave
and execution. Page unload warns about unacknowledged native changes.

## Execution contract

Each notebook owns its session and execution queue. Session startup is shared
by simultaneous callers and reuses a compatible native session when possible.
Closing a notebook tab leaves its session alive. Code, notebook and cell identity
are captured before enqueueing; a batch captures its cell list and source at
launch. Editing or changing tabs does not redirect results.

Execution has no 90-second deadline. A confirmed finish requires both
`execute_reply` and the matching IOPub `idle`, in either order. A reply without
idle after ten seconds leaves the result unconfirmed and cancels queued work.
WebSocket connection establishment has a 20-second deadline. Initial kernel
readiness has a two-minute budget, with a fresh kernel-info probe every five
seconds until a matching reply and idle status arrive. These retries never
execute user code. The final error distinguishes a missing reply from a reply
without idle confirmation. Disconnection, invalidation or kernel death ends
the wait without retrying user code. Later kernel-info probes have a five-second
deadline, inspection 2.5 seconds, and completion 1.4 seconds.

A lost connection rejects pending work as unconfirmed and cancels queued work.
Reconnect attempts wait 1, 2, 4 and 8 seconds and reuse the same native session.
No user code is replayed. A kernel-info request plus idle confirmation is
required before another execution. If the session disappeared, only an explicit
restart creates a replacement. Long busy kernels may not answer a probe;
manual reconnect remains available once they finish. The unconfirmed cell
retains its partial output and is not retroactively presented as successful.

Stop interrupts the current notebook's kernel immediately and cancels its
queue. It does not affect another notebook. Restart, rename, delete and runtime
changes coordinate with pending saves and invalidate old callbacks. An explicit
runtime change or restart stops the existing notebook session with
`DELETE /api/sessions/{id}`, confirms its removal, then creates a session with
`POST /api/sessions` and the requested kernelspec. A fresh session is created
without shutdown. This avoids POST reusing an old kernel and keeps startup on
DSS's notebook-session launch path. A failed shutdown preserves the old session;
if creation fails after shutdown, the old in-memory state is already lost and a
new explicit restart is required. Reloading shows “Not connected” until a
session is confirmed. A failed runtime change restores the old metadata; a
failed restoration is reported
separately. Permission or transport failures never silently count as success.

Outputs support immediate and deferred `clear_output`, and `display_id` updates
across requests. A rerun or output clear drops old display subscriptions. Native
cell IDs, raw cells, attachments and unowned nbformat fields survive serialization.

## DSS acceptance recipe (pending)

Record DSS version/build, plugin commit, browser version, deployment mode,
code environments and whether user isolation is enabled. Use disposable
notebooks and two non-admin users with the intended project permissions.

| Scenario | Procedure | Required result |
| --- | --- | --- |
| Native round trip | Open code, Markdown and raw cells with custom metadata and attachments; edit and reopen in DSS | Stable IDs, preserved custom fields, valid nbformat |
| Two notebooks | Edit A, immediately edit B; inspect both native documents | Both edits saved to the correct document |
| Long calculation | Run a Python cell sleeping for at least 120 seconds | Running past 90 seconds; final output persisted |
| Background execution | Run A, switch to B, then return to A | A receives its outputs; B remains unchanged |
| Concurrent editors | Both users open A; user 1 saves, then user 2 saves | User 2 sees a conflict; user 1's document remains current |
| Conflict resolution | Exercise export, save under a new name, and confirmed DSS reload | Local work preserved/exported; original DSS document not overwritten |
| Interrupted batch | Run a long first cell followed by a cell with a visible side effect; click Stop | First cell interrupted; subsequent side effect absent |
| Network loss | Disconnect the client while a cell has a visible side effect, then reconnect | Result unconfirmed; code not automatically run twice |
| Session removal | Stop the native session from DSS while the plugin is open | Restart required; no replacement created by reconnect |
| Display updates | Use IPython display with `display_id`, `update_display`, and `clear_output(wait=True)` | Existing output updated/cleared; no duplicate display |
| Recovery | Make an unsaved edit, reload, restore the draft; repeat and choose DSS | No automatic overwrite before a choice; both decisions work |
| Runtime switch | Select another valid code env; inspect `sys.executable`; simulate startup failure | Correct environment; failed switch restores old metadata or explicitly reports rollback failure |
| Rename/delete | Attempt during execution, then retry after interrupt and save | Active operations blocked; completed operations invalidate old sessions |
| Limited permissions | Remove notebook-write or kernel-operation permission | Structured error, preserved local draft, no false saved/executed state |

All rows require a recorded pass before publication. Concurrent edits from the
native DSS editor should also be tried; document the cross-process race limit
rather than claiming atomic protection.

### Kernel selection troubleshooting

If DSS returns `demo_python_env` while `dss_env` was selected, the session and
its attached kernel disagree with the selection. A normal session POST can
reuse a session solely by its path. Explicit switching stops the existing
session, confirms removal, and starts a fresh notebook session. The returned
kernelspec is verified before opening a WebSocket or sending code. Failure
cleanup deletes only a newly created session, never a surviving session.

A supplied DSS traceback shows `KeyError: 'DKU_EXTRA_ENV'` in
`notebook/dataiku/kernelmanager.py` during a kernel-name session PATCH. The
DSS launcher expects additional notebook launch context; generic kernel
switching does not supply it on this deployment. The plugin therefore avoids
both kernel-name PATCH and standalone `POST /api/kernels` during restart.
Session recreation still needs verification on the target DSS deployment.

Jupyter errors include the final server exception, HTTP status, method and path
without query tokens or the full internal traceback. A failed environment
change restores previous notebook metadata, but it cannot restore variables
from a kernel that has already been stopped. No user code is replayed.
