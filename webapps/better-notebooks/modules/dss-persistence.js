export function nativeDisplayMetadata(notebook) {
  return { id: notebook.id, name: notebook.name, open: notebook.open, updatedAt: notebook.updatedAt, folderId: notebook.folderId, remote: true, runtimeId: notebook.runtimeId };
}

export function saveStatus(label, timestamp = Date.now()) {
  return `${label} · ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}
