export function jupyterMessage(type, content, sessionId) {
  return { header: { msg_id: crypto.randomUUID(), username: 'better-notebooks', session: sessionId, msg_type: type, version: '5.3' }, parent_header: {}, metadata: {}, content };
}
export function jupyterOutput(message) {
  const type = message.header?.msg_type; const content = message.content || {};
  if (type === 'stream') return { output_type: 'stream', name: content.name || 'stdout', text: content.text || '' };
  if (type === 'error') return { output_type: 'error', ename: content.ename || 'Error', evalue: content.evalue || '', traceback: content.traceback || [] };
  if (type === 'execute_result') return { output_type: 'execute_result', execution_count: content.execution_count, data: content.data || {}, metadata: content.metadata || {} };
  if (type === 'display_data' || type === 'update_display_data') return { output_type: 'display_data', data: content.data || {}, metadata: content.metadata || {} };
  return null;
}
