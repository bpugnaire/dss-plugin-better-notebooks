/** Surface the server exception without exposing its full internal traceback. */
export function jupyterRequestError(payload, status, method, path) {
  const requestPath = `/jupyter/${path.replace(/^\//, '').split('?')[0]}`;
  const reason = payload.message || payload.reason || payload.error || 'Jupyter request failed';
  const lastLine = typeof payload.traceback === 'string' ? payload.traceback.trim().split('\n').at(-1).trim() : '';
  const exception = /^[\w.]+(?:Error|Exception):/.test(lastLine) ? lastLine.slice(0, 300) : '';
  const detail = exception && !String(reason).includes(exception) ? `${reason}: ${exception}` : reason;
  return Object.assign(new Error(`${detail} (HTTP ${status}, ${method} ${requestPath})`), {
    status, method, path: requestPath, serverException: exception,
  });
}
