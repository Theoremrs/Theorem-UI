// Donor: ELY-Open-Source/Ely-GPUI-Components @ 078bf26f2d039b3877aef577e37bbd0a1de182bf
// Path: crates/ely-documents/src/clock.rs
// Blob: 5af2d1256483b10b8085920b795b194a1305f933
// License: MIT, Copyright (c) 2026 Ely GPUI Component contributors (LICENSE-ELY)
//! How long a test's work keeps the thread busy.

use std::time::Duration;

/// The thread's CPU time, which a busy host does not inflate.
#[cfg(unix)]
pub(crate) fn spent(run: impl FnOnce()) -> Duration {
    use rustix::time::{ClockId, clock_gettime};
    let now = || {
        let at = clock_gettime(ClockId::ThreadCPUTime);
        Duration::new(at.tv_sec as u64, at.tv_nsec as u32)
    };
    let start = now();
    run();
    now() - start
}

/// The wall clock: Windows gives no thread clock without `unsafe`.
#[cfg(not(unix))]
pub(crate) fn spent(run: impl FnOnce()) -> Duration {
    let start = web_time::Instant::now();
    run();
    start.elapsed()
}
