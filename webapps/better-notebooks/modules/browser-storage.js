/** Storage can throw on reads, writes, or even access (private mode, quotas). */
export function safeStorage(getStorage, onUnavailable = () => {}) {
  return {
    getItem(key) { try { return getStorage().getItem(key); } catch (error) { onUnavailable(error); return null; } },
    setItem(key, value) { try { getStorage().setItem(key, value); return true; } catch (error) { onUnavailable(error); return false; } },
    removeItem(key) { try { getStorage().removeItem(key); return true; } catch (error) { onUnavailable(error); return false; } },
  };
}
export function scopedDraftKey(namespace, project, webapp, notebook) {
  return `${namespace}:draft:${[project, webapp, notebook].map(encodeURIComponent).join(':')}`;
}
