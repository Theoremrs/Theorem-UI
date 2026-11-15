//! Constructors for panel kinds, registered by the crates that own the panels.
//! A kind with no constructor, or saved at a version this build does not serve,
//! is opened as the [`Unavailable`](crate::panels::Unavailable) placeholder:
//! a layout never fails to load because of one panel (R48).

use std::collections::BTreeMap;

use serde_json::Value;

use crate::ids::PanelKind;
use crate::panel::{OpenTarget, Panel};

/// Builds a panel from its saved view state (`Null` for a new one) and the
/// version it was saved at, which may be older than the one served.
pub type Constructor = Box<dyn Fn(&Value, u32) -> Box<dyn Panel>>;

/// Whether a panel kind opens `target`. The kind's constructor is then built
/// from [`OpenTarget::state`].
pub type Opener = Box<dyn Fn(&OpenTarget) -> bool>;

#[derive(Default)]
pub struct PanelFactories {
    constructors: BTreeMap<PanelKind, Constructor>,
    /// In registration order: the first kind that claims a target opens it.
    openers: Vec<(PanelKind, Opener)>,
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

    /// Declare that `kind` opens the targets `opens` accepts, so a panel's
    /// `cx.open(target)` reaches it without the root naming any kind. Register
    /// the kind's constructor too. A kind may register once.
    pub fn register_opener(&mut self, kind: &str, opens: impl Fn(&OpenTarget) -> bool + 'static) {
        let kind = PanelKind::new(kind);
        self.openers.retain(|(k, _)| *k != kind);
        self.openers.push((kind, Box::new(opens)));
    }

    /// The kind that opens `target`, if any is registered.
    pub fn opener_of(&self, target: &OpenTarget) -> Option<&PanelKind> {
        self.openers
            .iter()
            .find(|(_, opens)| opens(target))
            .map(|(kind, _)| kind)
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
