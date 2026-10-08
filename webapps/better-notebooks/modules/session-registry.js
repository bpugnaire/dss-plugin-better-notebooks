import { jupyterMessage, reduceOutput } from './kernel-protocol.js';
const sessionPath = item => String(item.path || item.notebook?.path || '').replace(/^\//, '');
export const uncertainError = message => Object.assign(new Error(message), { code: 'RESULT_UNCONFIRMED' });
/** Transport-independent session lifecycle. Never replays execution requests. */
export class SessionRegistry {
  constructor({ request, socketFactory, socketUrl, onState = () => {}, onDisconnect = () => {}, onAutomaticRestart = () => {}, onReconnectError = () => {}, clock = globalThis, startupTimeout = 120000 }) {
    Object.assign(this, { request, socketFactory, socketUrl, onState, onDisconnect, onAutomaticRestart, onReconnectError, clock, startupTimeout }); this.sessions = new Map();
  }
  setState(session, state) { session.state = state; this.onState(session.notebook, state); }
  async connect(notebook, path, kernelName, { replaceKernel = false } = {}) {
    let s = this.sessions.get(notebook);
    if (s?.reconnecting) { await s.reconnecting; s = this.sessions.get(notebook); }
    if (s?.connecting) return s.connecting;
    if (s && !s.invalid) {
      if (s.socket?.readyState === 1) return s;
      throw uncertainError('Session disconnected. Reconnect or restart explicitly.');
    }
    s = { notebook, path, kernelName, pending: new Map(), displays: new Map(), owners: new Map(), sessionId: crypto.randomUUID(), invalid: false, state: 'starting' };
    this.sessions.set(notebook, s); this.setState(s, 'starting');
    s.connecting = (async () => {
      try {
        const sessions = await this.request('api/sessions');
        const existingSessionIds = new Set(sessions.map(item => item.id));
        const existingKernelIds = new Set(sessions.map(item => item.kernel?.id));
        const compatible = sessions.find(item => sessionPath(item) === path.replace(/^\//, '') && item.kernel?.name === kernelName);
        const samePath = replaceKernel ? sessions.find(item => sessionPath(item) === path.replace(/^\//, '')) : null;
        const createSession = () => this.request('api/sessions', { method: 'POST', body: JSON.stringify({ path, type: 'notebook', name: '', kernel: { id: null, name: kernelName } }) });
        let native = compatible || samePath || await createSession();
        if (s.invalid) throw uncertainError('Session was invalidated during startup.');
        if (!native.id || !native.kernel?.id) throw new Error('DSS started a session without a session or kernel identifier.');
        const newlyCreated = item => !existingSessionIds.has(item.id) && !existingKernelIds.has(item.kernel?.id);
        s.createdNative = newlyCreated(native);
        s.dssSessionId = native.id;
        // DSS requires notebook-specific launch context (DKU_EXTRA_ENV).
        // Launch through session creation, never kernel-name PATCH or a bare
        // kernel POST. Stop existing sessions only for an explicit restart or
        // automatic recovery of a confirmed dead kernel.
        if (replaceKernel && !s.createdNative) {
          const previousSessionId = native.id;
          const previousKernelId = native.kernel.id;
          await this.request(`api/sessions/${encodeURIComponent(previousSessionId)}`, { method: 'DELETE' });
          if (s.invalid) throw uncertainError('Session was invalidated during restart.');
          const remaining = await this.request('api/sessions');
          if (remaining.some(item => item.id === previousSessionId || item.kernel?.id === previousKernelId)) {
            throw new Error('DSS kept the old notebook session after the restart shutdown request.');
          }
          // Record all surviving sessions so a concurrently created session
          // returned by POST is never treated as ours during failure cleanup.
          for (const item of remaining) {
            existingSessionIds.add(item.id); existingKernelIds.add(item.kernel?.id);
          }
          native = await createSession();
          if (!native.id || !native.kernel?.id) throw new Error('DSS started a session without a session or kernel identifier.');
          s.createdNative = newlyCreated(native);
          s.dssSessionId = native.id;
          if (!s.createdNative) throw new Error('DSS reused an existing session or kernel after the explicit restart request.');
          if (s.invalid) throw uncertainError('Session was invalidated during session creation.');
        }
        if (native.kernel.name !== kernelName) throw new Error(`DSS returned kernel \"${native.kernel.name || 'unknown'}\" instead of requested kernel \"${kernelName}\".`);
        s.kernelId = native.kernel.id;
        await this.open(s);
        await this.waitForReady(s);
        return s;
      } catch (error) {
        if (!s.invalid) {
          if (s.socket) { const socket = s.socket; s.socket = null; socket.close(); }
          this.setState(s, 'disconnected');
        }
        error.message = `Starting kernel \"${kernelName}\": ${error.message}`;
        throw error;
      }
      finally { s.connecting = null; }
    })();
    return s.connecting;
  }
  async replace(notebook, path, kernelName) {
    this.invalidate(notebook);
    try { return await this.connect(notebook, path, kernelName, { replaceKernel: true }); }
    catch (error) {
      const failed = this.sessions.get(notebook);
      // Clean only a newly created native session; never a surviving session.
      const sessionId = failed?.createdNative ? failed.dssSessionId : null;
      this.invalidate(notebook);
      if (sessionId) {
        try { await this.request(`api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }); }
        catch (cleanupError) { error.message += ` Failed-session cleanup also failed: ${cleanupError.message}`; }
      }
      throw error;
    }
  }
  async open(s) {
    const socket = this.socketFactory(this.socketUrl(s.kernelId, s.sessionId)); s.socket = socket;
    socket.addEventListener('message', event => {
      if (s.invalid || s.socket !== socket) return;
      try { this.message(s, JSON.parse(event.data)); } catch { /* Ignore malformed transport frames. */ }
    });
    socket.addEventListener('close', () => {
      if (s.invalid || s.socket !== socket) return;
      this.setState(s, 'disconnected');
      this.rejectPending(s, uncertainError('Connection lost; the execution result is not confirmed.'));
      this.onDisconnect(s.notebook);
      if (!s.connecting) this.reconnect(s).catch(() => {});
    });
    await new Promise((resolve, reject) => {
      let done = false;
      const finish = error => { if (done) return; done = true; this.clock.clearTimeout(timer); error ? reject(error) : resolve(); };
      const timer = this.clock.setTimeout(() => { finish(uncertainError('Kernel connection timed out.')); if (s.socket === socket) s.socket = null; socket.close(); }, 20000);
      socket.addEventListener('open', () => finish(), { once: true });
      socket.addEventListener('error', () => { finish(uncertainError('Kernel connection failed.')); if (s.socket === socket) s.socket = null; socket.close(); }, { once: true });
      socket.addEventListener('close', () => finish(uncertainError('Kernel connection closed.')), { once: true });
    });
  }
  async reconnect(s, manual = false) {
    if (s.invalid || s.reconnecting) return s.reconnecting;
    s.reconnecting = (async () => {
      let lastError;
      for (const delay of manual ? [0] : [1000, 2000, 4000, 8000]) {
        await new Promise(resolve => { s.reconnectTimer = this.clock.setTimeout(resolve, delay); s.wakeReconnect = resolve; });
        if (s.invalid) return;
        try {
          const sessions = await this.request('api/sessions');
          if (s.invalid) return;
          const existing = sessions.find(item => item.id === s.dssSessionId && item.kernel?.id === s.kernelId);
          const dead = existing && (s.kernelDead || existing.kernel.execution_state === 'dead');
          if (!existing || dead) {
            this.setState(s, 'missing');
            this.invalidate(s.notebook);
            try {
              await this.connect(s.notebook, s.path, s.kernelName, { replaceKernel: Boolean(dead) });
              this.onAutomaticRestart(s.notebook);
            } catch (error) {
              const current = this.sessions.get(s.notebook);
              if (current && !current.invalid) this.onReconnectError(s.notebook, error);
              throw error;
            }
            return;
          }
          await this.open(s); await this.probe(s); return;
        } catch (error) {
          if (s.invalid) return;
          lastError = error;
          if (s.socket) { const socket = s.socket; s.socket = null; socket.close(); }
        }
      }
      if (!s.invalid) {
        this.setState(s, 'disconnected');
        this.onReconnectError(s.notebook, lastError || uncertainError('Kernel reconnection failed.'));
      }
    })().finally(() => { s.reconnecting = null; });
    return s.reconnecting;
  }
  async waitForReady(s) {
    const now = () => typeof this.clock.now === 'number' ? this.clock.now : Date.now();
    const deadline = now() + this.startupTimeout;
    let lastError;
    while (now() < deadline) {
      try {
        await this.probe(s, Math.min(5000, deadline - now()), true);
        return;
      } catch (error) {
        if (!error.readinessTimedOut) throw error;
        lastError = error;
      }
    }
    throw uncertainError(`Kernel readiness timed out after ${this.startupTimeout / 1000} seconds. ${lastError?.readinessDetail || 'Readiness was not confirmed.'}`);
  }
  probe(s, timeout = 5000, starting = false) {
    this.setState(s, starting ? 'starting' : 'unknown');
    return this.send(s, 'kernel_info_request', {}, 'info', timeout).then(() => {
      // A reply proves the kernel accepted a request, but idle must also be observed.
      if (s.state !== 'idle') this.setState(s, 'unknown');
    });
  }
  send(s, type, content, kind, timeout) {
    if (s.invalid || s.socket?.readyState !== 1) return Promise.reject(uncertainError('Kernel is disconnected.'));
    const message = jupyterMessage(type, content, s.sessionId);
    return new Promise((resolve, reject) => {
      const r = { kind, resolve, reject, outputs: [], displays: new Map(), reply: false, idle: false };
      if (timeout) r.timeout = this.clock.setTimeout(() => {
        s.pending.delete(message.header.msg_id);
        const error = uncertainError(`${kind === 'info' ? 'Kernel readiness' : 'Kernel response'} timed out after ${timeout / 1000} seconds.`);
        if (kind === 'info') {
          error.readinessTimedOut = true;
          error.readinessDetail = r.reply ? 'A kernel_info_reply was received, but no matching idle status arrived.' : 'No kernel_info_reply was received for the latest readiness probe.';
          error.message += ` ${error.readinessDetail}`;
        }
        reject(error);
      }, timeout);
      s.pending.set(message.header.msg_id, r);
      try { s.socket.send(JSON.stringify({ ...message, channel: 'shell' })); }
      catch (error) { this.clock.clearTimeout(r.timeout); s.pending.delete(message.header.msg_id); reject(uncertainError(error.message)); }
    });
  }
  execute(s, source, onOutput, { silent = false, owner = null } = {}) {
    if (s.state !== 'idle') return Promise.reject(uncertainError('Kernel is busy or its state is unknown. Reconnect or restart before running.'));
    if (owner) this.clearOutputs(s.notebook, owner);
    this.setState(s, 'busy');
    const promise = this.send(s, 'execute_request', { code: source, silent, store_history: !silent, user_expressions: {}, allow_stdin: false, stop_on_error: true }, 'execute');
    const last = [...s.pending.entries()].at(-1);
    if (last) { const [id, request] = last; request.onOutput = onOutput; request.owner = owner; if (owner) s.owners.set(owner, id); }
    return promise;
  }
  message(s, message) {
    const type = message.header?.msg_type; const content = message.content || {}; const id = message.parent_header?.msg_id;
    if (type === 'status') {
      if (content.execution_state === 'idle') this.setState(s, 'idle');
      else if (content.execution_state === 'busy') this.setState(s, 'busy');
      else if (content.execution_state === 'dead') {
        s.kernelDead = true;
        this.setState(s, 'missing'); this.rejectPending(s, uncertainError('Kernel died.')); this.onDisconnect(s.notebook);
        const socket = s.socket; s.socket = null; socket?.close();
        if (!s.connecting) this.reconnect(s).catch(() => {});
      }
    }
    if (type === 'update_display_data') {
      for (const r of s.displays.values()) if (reduceOutput(r, message)) r.onOutput?.(r.outputs);
      return;
    }
    const r = s.pending.get(id); if (!r) return;
    if (r.kind === 'inspect' && type === 'inspect_reply') return this.finish(s, id, content.found ? (content.data?.['text/plain'] || '') : '');
    if (r.kind === 'complete' && type === 'complete_reply') return this.finish(s, id, { matches: content.matches || [], cursorStart: content.cursor_start });
    if (r.kind === 'info') {
      if (type === 'kernel_info_reply') r.reply = true;
      if (type === 'status' && content.execution_state === 'idle') r.idle = true;
      if (r.reply && r.idle) this.finish(s, id, {});
      return;
    }
    if (r.kind !== 'execute') return;
    s.displays.set(id, r);
    if (reduceOutput(r, message)) r.onOutput?.(r.outputs);
    if (type === 'execute_reply') {
      r.reply = true; r.executionCount = content.execution_count;
      if (content.status === 'error' && !r.outputs.some(output => output.output_type === 'error')) r.outputs.push({ output_type: 'error', ename: content.ename, evalue: content.evalue, traceback: content.traceback || [] });
      if (content.status === 'aborted') r.aborted = true;
      if (!r.idle) r.timeout = this.clock.setTimeout(() => { s.pending.delete(id); this.setState(s, 'unknown'); r.reject(uncertainError('Execution reply received without an idle confirmation.')); this.onDisconnect(s.notebook); }, 10000);
    }
    if (type === 'status' && content.execution_state === 'idle') r.idle = true;
    if (r.reply && r.idle) {
      if (r.aborted) { this.clock.clearTimeout(r.timeout); s.pending.delete(id); r.reject(Object.assign(new Error('Execution interrupted.'), { code: 'INTERRUPTED' })); }
      else this.finish(s, id, { outputs: r.outputs, executionCount: r.executionCount });
      if (!r.displays.size) s.displays.delete(id);
    }
  }
  clearOutputs(notebook, owner) {
    const s = this.sessions.get(notebook); if (!s) return;
    const id = s.owners.get(owner); if (!id) return;
    s.displays.delete(id); s.owners.delete(owner);
    const pending = s.pending.get(id);
    if (pending) { pending.outputs.length = 0; pending.displays.clear(); pending.onOutput?.(pending.outputs); }
  }
  finish(s, id, value) { const r = s.pending.get(id); if (!r) return; this.clock.clearTimeout(r.timeout); s.pending.delete(id); r.resolve(value); }
  rejectPending(s, error) { for (const r of s.pending.values()) { this.clock.clearTimeout(r.timeout); r.reject(error); } s.pending.clear(); }
  busy(notebook) { const s = this.sessions.get(notebook); return Boolean(s && (s.connecting || s.reconnecting || ['busy', 'unknown', 'disconnected', 'missing', 'interrupting'].includes(s.state))); }
  async interrupt(notebook) {
    const s = this.sessions.get(notebook); if (!s?.kernelId) return;
    this.setState(s, 'interrupting');
    try { await this.request(`api/kernels/${encodeURIComponent(s.kernelId)}/interrupt`, { method: 'POST', body: '{}' }); }
    catch (error) { this.setState(s, 'unknown'); throw error; }
    this.rejectPending(s, Object.assign(new Error('Execution interrupted.'), { code: 'INTERRUPTED' }));
    // Probe for an actual idle confirmation instead of assuming interruption succeeded.
    await this.probe(s).catch(() => this.setState(s, 'unknown'));
  }
  invalidate(notebook) {
    const s = this.sessions.get(notebook); if (!s) return;
    s.invalid = true; this.clock.clearTimeout(s.reconnectTimer); s.wakeReconnect?.();
    this.rejectPending(s, uncertainError('Session invalidated.')); s.socket?.close(); s.displays.clear(); s.owners.clear(); this.sessions.delete(notebook);
  }
}
