export class ExecutionQueue {
  constructor() { this.entries = new Map(); }
  entry(key) {
    if (!this.entries.has(key)) this.entries.set(key, { jobs: [], active: false, epoch: 0 });
    return this.entries.get(key);
  }
  enqueue(key, task) {
    const e = this.entry(key);
    return new Promise((resolve, reject) => { e.jobs.push({ task, resolve, reject, epoch: e.epoch }); this.drain(key); });
  }
  async drain(key) {
    const e = this.entry(key); if (e.active) return;
    e.active = true;
    try {
      while (e.jobs.length) {
        const job = e.jobs.shift();
        try { job.resolve(await job.task(() => job.epoch !== e.epoch)); }
        catch (error) { job.reject(error); this.cancel(key, error); }
      }
    } finally { e.active = false; }
  }
  cancel(key, error = Object.assign(new Error('Execution cancelled.'), { code: 'INTERRUPTED' })) {
    const e = this.entry(key); e.epoch += 1;
    e.jobs.splice(0).forEach(job => job.reject(error));
  }
  busy(key) { const e = this.entry(key); return e.active || e.jobs.length > 0; }
}
