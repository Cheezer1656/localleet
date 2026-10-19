// Runner: owns one Web Worker per language and executes jobs from LeetCode
// tabs. The same page runs as Chrome's offscreen document and as Firefox's
// background page, so it never lives inside the LeetCode page itself.
//
// Content script <-> runner (runtime Port named "localleet-runner"):
//   -> {type:'warmup', lang}
//   -> {type:'run', id, lang, code, meta, slug, cases: string[][], timeoutMs}
//   -> {type:'cancel'}
//   <- {type:'status', lang, state:'loading'|'ready'|'error', runtime?, error?}
//   <- {type:'queued', id}
//   <- {type:'case', id, index, result}
//   <- {type:'done', id, compileError?, timedOut?, cancelled?, internalError?}
//   <- {type:'unsupported', id?, lang}
//
// Runner <-> language worker (postMessage):
//   <- {type:'ready', runtime} | {type:'fatal', error}
//   -> {type:'run', code, meta, slug, cases}
//   <- {type:'compiled'}  (optional: compilation finished, restarts the timer)
//   <- {type:'case', index, result:{status, output, stdout, error, timeMs}}
//   <- {type:'done', compileError?, internalError?}

import { languageFor } from '../languages/index.js';

const api = globalThis.browser ?? globalThis.chrome;
const PORT_NAME = 'localleet-runner';
const IDLE_SHUTDOWN_MS = 10 * 60 * 1000;

const ports = new Set();
const hosts = new Map();

function safePost(port, msg) {
  try {
    port.postMessage(msg);
  } catch {
    // Port already closed (tab navigated away).
  }
}

class WorkerHost {
  constructor(language) {
    this.language = language;
    this.status = { state: 'loading' };
    this.queue = [];
    this.job = null;
    this.spawn();
  }

  setStatus(status) {
    this.status = status;
    for (const port of ports) {
      for (const lang of this.language.leetcodeLangs) {
        if (port.langs?.has(lang)) safePost(port, { type: 'status', lang, ...status });
      }
    }
  }

  spawn() {
    this.worker?.terminate();
    this.failed = false;
    this.setStatus({ state: 'loading' });
    this.worker = new Worker(this.language.worker, { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.ready.catch(() => {});
    this.worker.onmessage = ({ data }) => this.handle(data);
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      this.fail(e.message || 'The language worker crashed.');
    };
  }

  // The toolchain is unusable: fail the current and queued jobs. The next
  // run() respawns the worker.
  fail(error) {
    this.failed = true;
    this.setStatus({ state: 'error', error });
    this.rejectReady(new Error(error));
    this.finish({ internalError: error });
    for (const job of this.queue.splice(0)) job.emit({ type: 'done', internalError: error });
  }

  handle(msg) {
    switch (msg.type) {
      case 'ready':
        this.setStatus({ state: 'ready', runtime: msg.runtime });
        this.resolveReady();
        break;
      case 'fatal':
        this.fail(msg.error);
        break;
      case 'compiled':
        // Compile time doesn't count against the first testcase.
        if (this.job) this.armTimer();
        break;
      case 'case':
        if (!this.job) return;
        this.job.emit({ type: 'case', index: msg.index, result: msg.result });
        this.job.nextIndex = msg.index + 1;
        this.armTimer();
        break;
      case 'done':
        this.finish({ compileError: msg.compileError, internalError: msg.internalError });
        // An internal error (e.g. a fatal interpreter crash on stack overflow)
        // can leave the interpreter unusable, so start from a fresh one.
        if (msg.internalError) this.spawn();
        this.pump();
        break;
    }
  }

  armTimer() {
    clearTimeout(this.job?.timer);
    if (this.job) this.job.timer = setTimeout(() => this.timeout(), this.job.timeoutMs);
  }

  timeout() {
    const job = this.job;
    if (!job) return;
    job.emit({
      type: 'case',
      index: job.nextIndex,
      result: {
        status: 'timeout',
        output: null,
        stdout: '',
        error: `Time Limit Exceeded (over ${job.timeoutMs / 1000}s locally)`,
        timeMs: job.timeoutMs,
      },
    });
    this.finish({ timedOut: true });
    this.spawn(); // The only way to stop a busy worker is to kill it.
    this.pump();
  }

  finish(extra) {
    const job = this.job;
    if (!job) return;
    clearTimeout(job.timer);
    this.job = null;
    job.emit({ type: 'done', ...extra });
  }

  run(job) {
    this.queue.push(job);
    if (this.job) job.emit({ type: 'queued' });
    this.pump();
  }

  cancel(port) {
    for (const job of this.queue.filter((j) => j.port === port)) {
      this.queue.splice(this.queue.indexOf(job), 1);
      job.emit({ type: 'done', cancelled: true });
    }
    if (this.job?.port === port) {
      this.finish({ cancelled: true });
      this.spawn();
      this.pump();
    }
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.job && this.queue.length) {
        if (this.failed) this.spawn();
        const ready = this.ready;
        try {
          await ready;
        } catch {
          return; // fail() already rejected the queue.
        }
        if (ready !== this.ready || this.job || !this.queue.length) continue;
        const job = this.queue.shift();
        this.job = job;
        this.worker.postMessage({
          type: 'run',
          code: job.request.code,
          meta: job.request.meta,
          slug: job.request.slug,
          cases: job.request.cases,
        });
        this.armTimer();
      }
    } finally {
      this.pumping = false;
    }
  }

  terminate() {
    this.worker.terminate();
  }
}

function hostFor(lang) {
  const language = languageFor(lang);
  if (!language) return null;
  let host = hosts.get(language.id);
  if (!host) {
    host = new WorkerHost(language);
    hosts.set(language.id, host);
  }
  return host;
}

// Status updates are broadcast to every tab that has used a language; also
// answer each request directly so the tab's label reflects this language.
function subscribe(port, lang, host) {
  (port.langs ??= new Set()).add(lang);
  safePost(port, { type: 'status', lang, ...host.status });
}

let idleTimer = null;

api.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  ports.add(port);
  clearTimeout(idleTimer);

  port.onMessage.addListener((msg) => {
    if (msg.type === 'warmup' || msg.type === 'run') {
      const host = hostFor(msg.lang);
      if (!host) {
        safePost(port, { type: 'unsupported', id: msg.id, lang: msg.lang });
        return;
      }
      subscribe(port, msg.lang, host);
      if (msg.type === 'run') {
        host.run({
          port,
          request: msg,
          timeoutMs: msg.timeoutMs ?? 10000,
          nextIndex: 0,
          timer: null,
          emit: (event) => safePost(port, { ...event, id: msg.id }),
        });
      }
    } else if (msg.type === 'cancel') {
      for (const host of hosts.values()) host.cancel(port);
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(port);
    for (const host of hosts.values()) host.cancel(port);
    if (!ports.size) {
      // Free the interpreters' memory once no LeetCode tab has used us for a while.
      idleTimer = setTimeout(() => {
        for (const host of hosts.values()) host.terminate();
        hosts.clear();
      }, IDLE_SHUTDOWN_MS);
    }
  });
});

// Content scripts call this before connecting. In Chrome the service worker
// also answers (creating this document first if needed); either reply is fine.
api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'localleet:ensure-runner') {
    sendResponse({ ok: true });
  }
});
