/* Browser-executed smoke probe for the standalone development surface.
 * Open standalone.html?smoke=1 or run it through the repository browser test.
 */
if (new URLSearchParams(window.location.search).has('smoke')) {
  const waitFor = async predicate => {
    const until = Date.now() + 4000;
    while (!predicate() && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 40));
    return predicate();
  };
  (async () => {
    const initialCells = await waitFor(() => document.querySelectorAll('.cell').length >= 4);
    const initialEditors = document.querySelectorAll('.cm-editor').length;
    const firstEditor = document.querySelector('.cm-content'); firstEditor?.focus();
    const focusHeld = document.activeElement?.closest('.cm-editor') != null;
    const lastRun = [...document.querySelectorAll('.cell .run-cell')].at(-1); lastRun?.click();
    await new Promise(resolve => setTimeout(resolve, 80));
    window.__betterNotebooksSmoke = { pass: initialCells && initialEditors >= 4 && focusHeld, cells: document.querySelectorAll('.cell').length, editors: initialEditors, focusHeld };
    document.documentElement.dataset.betterNotebooksSmoke = window.__betterNotebooksSmoke.pass ? 'pass' : 'fail';
  })();
}
