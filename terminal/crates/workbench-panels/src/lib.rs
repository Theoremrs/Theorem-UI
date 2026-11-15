//! Child panels of the Theo Web terminal workbench, each written against the
//! interaction core's `Panel` trait and nothing else.

pub mod files;

use theorem_workbench_core::PanelFactories;

pub use files::{FilesPanel, Handle as FilesHandle, OpenRequest};

/// Register every panel this crate has. The returned handle is how the host
/// names the workspace the Files panels list and reads their open requests.
pub fn register(factories: &mut PanelFactories) -> FilesHandle {
    files::register(factories)
}
