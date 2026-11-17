//! The text and caret a text-edit node publishes. The implementation lives in
//! the core (`theorem_workbench_core::caret`) so the core's own text boxes and
//! every panel share one escaping and one UTF-16 count; this re-exports it.

pub use theorem_workbench_core::caret::*;
