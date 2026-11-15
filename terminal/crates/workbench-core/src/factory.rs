//! Constructors for panel kinds, registered by the crates that own the panels.
//! A kind with no constructor, or saved at a version this build does not serve,
//! is opened as the [`Unavailable`](crate::panels::Unavailable) placeholder:
//! a layout never fails to load because of one panel (R48).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::ids::PanelKind;
use crate::panel::Panel;

/// Builds a panel from its saved view state (`Null` for a new one) and the
/// version it was saved at, which may be older than the one served.
pub type Constructor = Box<dyn Fn(&Value, u32) -> Box<dyn Panel>>;

#[derive(Default)]
pub struct PanelFactories {
    constructors: BTreeMap<PanelKind, Constructor>,
}

impl PanelFactories {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register or replace the constructor for `kind`.
    pub fn register(
        &mut self,
        kind: &str,
        constructor: impl Fn(&Value, u32) -> Box<dyn Panel> + 'static,
    ) {
        self.constructors
            .insert(PanelKind::new(kind), Box::new(constructor));
    }

    pub fn has(&self, kind: &PanelKind) -> bool {
        self.constructors.contains_key(kind)
    }

    pub(crate) fn create(
        &self,
        kind: &PanelKind,
        state: &Value,
        saved_version: u32,
    ) -> Option<Box<dyn Panel>> {
        self.constructors.get(kind).map(|c| c(state, saved_version))
    }
}
