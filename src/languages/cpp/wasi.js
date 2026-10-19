// Minimal WASI preview1 host for running compiled submissions: argv, stdin
// from a buffer, writes to any fd handed to a callback, clocks and random.
// There is no filesystem; everything else reports ENOSYS.

const ESUCCESS = 0;
const EBADF = 8;
const ENOSYS = 52;
const ESPIPE = 70;
const MAX_FD = 4; // stdin, stdout, stderr, harness frames (3), spare (4)

export class WasiExit extends Error {
  constructor(code) {
    super(`exit(${code})`);
    this.code = code;
  }
}

// Instantiates `module` and runs its _start. Returns the exit code; traps
// (RuntimeError, RangeError for stack overflow) propagate to the caller.
export function runWasi(module, { args = [], stdin = new Uint8Array(0), onWrite }) {
  const encoder = new TextEncoder();
  const argv = args.map((a) => encoder.encode(`${a}\0`));
  let memory = null;
  let stdinPos = 0;

  const view = () => new DataView(memory.buffer);
  const bytes = () => new Uint8Array(memory.buffer);

  const writeStrings = (list, ptrsPtr, bufPtr) => {
    const dv = view();
    for (const s of list) {
      dv.setUint32(ptrsPtr, bufPtr, true);
      bytes().set(s, bufPtr);
      ptrsPtr += 4;
      bufPtr += s.length;
    }
    return ESUCCESS;
  };

  const now = (id) => {
    const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
    return BigInt(Math.round(ms * 1e6));
  };

  const wasi = {
    args_sizes_get(countPtr, sizePtr) {
      const dv = view();
      dv.setUint32(countPtr, argv.length, true);
      dv.setUint32(sizePtr, argv.reduce((n, a) => n + a.length, 0), true);
      return ESUCCESS;
    },
    args_get: (ptrs, buf) => writeStrings(argv, ptrs, buf),
    environ_sizes_get(countPtr, sizePtr) {
      const dv = view();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return ESUCCESS;
    },
    environ_get: () => ESUCCESS,
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      if (fd < 1 || fd > MAX_FD) return EBADF;
      const dv = view();
      let total = 0;
      const chunks = [];
      for (let k = 0; k < iovsLen; k++) {
        const ptr = dv.getUint32(iovs + k * 8, true);
        const len = dv.getUint32(iovs + k * 8 + 4, true);
        chunks.push(bytes().slice(ptr, ptr + len));
        total += len;
      }
      for (const c of chunks) if (c.length) onWrite(fd, c);
      view().setUint32(nwrittenPtr, total, true);
      return ESUCCESS;
    },
    fd_read(fd, iovs, iovsLen, nreadPtr) {
      if (fd !== 0) return EBADF;
      const dv = view();
      let total = 0;
      for (let k = 0; k < iovsLen && stdinPos < stdin.length; k++) {
        const ptr = dv.getUint32(iovs + k * 8, true);
        const len = dv.getUint32(iovs + k * 8 + 4, true);
        const chunk = stdin.subarray(stdinPos, stdinPos + len);
        bytes().set(chunk, ptr);
        stdinPos += chunk.length;
        total += chunk.length;
      }
      view().setUint32(nreadPtr, total, true);
      return ESUCCESS;
    },
    fd_fdstat_get(fd, ptr) {
      if (fd < 0 || fd > MAX_FD) return EBADF;
      const dv = view();
      dv.setUint8(ptr, 2); // character device
      dv.setUint16(ptr + 2, 0, true);
      dv.setBigUint64(ptr + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(ptr + 16, 0xffffffffffffffffn, true);
      return ESUCCESS;
    },
    fd_fdstat_set_flags: () => ESUCCESS,
    fd_close: () => ESUCCESS,
    fd_seek: (fd) => (fd <= MAX_FD ? ESPIPE : EBADF),
    fd_prestat_get: () => EBADF,
    fd_prestat_dir_name: () => EBADF,
    clock_res_get(_id, ptr) {
      view().setBigUint64(ptr, 1000n, true);
      return ESUCCESS;
    },
    clock_time_get(id, _precision, ptr) {
      view().setBigUint64(ptr, now(id), true);
      return ESUCCESS;
    },
    random_get(ptr, len) {
      for (let off = 0; off < len; off += 65536) {
        crypto.getRandomValues(new Uint8Array(memory.buffer, ptr + off, Math.min(65536, len - off)));
      }
      return ESUCCESS;
    },
    sched_yield: () => ESUCCESS,
    proc_exit(code) {
      throw new WasiExit(code);
    },
  };

  const imports = {};
  for (const imp of WebAssembly.Module.imports(module)) {
    if (imp.kind !== 'function') continue;
    imports[imp.module] ??= {};
    imports[imp.module][imp.name] =
      imp.module === 'wasi_snapshot_preview1' && wasi[imp.name] ? wasi[imp.name] : () => ENOSYS;
  }

  const instance = new WebAssembly.Instance(module, imports);
  memory = instance.exports.memory;
  try {
    instance.exports._start();
    return 0;
  } catch (err) {
    if (err instanceof WasiExit) return err.code;
    throw err;
  }
}
