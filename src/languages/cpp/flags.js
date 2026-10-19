// Compiler flags shared by the worker and scripts/build.mjs. The prelude is
// precompiled at build time, and a PCH only loads with the flags it was built
// with, so both sides must use exactly these.

export const COMPILE_FLAGS = [
  '-std=c++23',
  '-O2',
  '-fno-color-diagnostics',
  '-ferror-limit=20',
  // The UBSan checks LeetCode's judge reports most often. The handlers are
  // implemented in prelude.h, since the sysroot ships no sanitizer runtime.
  '-fsanitize=null,signed-integer-overflow,shift,integer-divide-by-zero,return,unreachable,vla-bound,array-bounds',
  '-fno-sanitize-recover=all',
  // Bounds-checked operator[] etc. stand in for AddressSanitizer. Debug mode
  // is the one that reports a message rather than just trapping.
  '-D_LIBCPP_HARDENING_MODE=_LIBCPP_HARDENING_MODE_DEBUG',
  '-Iinclude',
];

export const LINK_FLAGS = [
  // Put the stack first so overflowing it traps instead of silently
  // corrupting static data, and make it large enough for deep recursion.
  '-Wl,--stack-first',
  '-Wl,-z,stack-size=16777216',
  '-Wl,--max-memory=1073741824',
];

// Paths inside the compiler's virtual filesystem.
export const PRELUDE = 'prelude.h';
export const PCH = 'prelude.pch';
