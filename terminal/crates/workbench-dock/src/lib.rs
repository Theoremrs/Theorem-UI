//! The workbench dock: the one owner of the Theo Web workbench layout.
//!
//! A `Dock` holds tab groups over Herdr's split tree (`theorem-workbench-layout`).
//! It is pure data and pure geometry: no I/O, clocks or globals, so an
//! Elm-style root can keep one in its model, call the operations from `update`
//! and call `solve(area, metrics)` from `view`.
//!
//! The dock is solved in terminal cells. Pixel targets (Files 224 px, main
//! minimum 480 px, tools minimum 320 px, 8 px splitter hit regions) are
//! converted with the caller's cell metrics. Regions and one-cell gutters add
//! up to the area exactly; rounding leaves its remainder at a boundary.

mod doc;
mod dock;
mod solve;
mod types;

pub use doc::{DockDocument, GroupDoc, Repair, RestoreReport, SCHEMA, VERSION};
pub use dock::{Dock, Group, Preset, Regions};
pub use solve::{
    DrawerFrame, GUTTER, GroupFrame, Hit, Presentation, SolvedFrame, SplitterFrame, Suppressed,
    TabFrame,
};
pub use types::*;
