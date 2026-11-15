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

/// The priority `register_opener` gives: what a catch-all opener has.
pub const OPENER_DEFAULT: i32 = 0;
/// The priority of an opener for a narrower set of targets than a catch-all,
/// such as Markdown for its file extensions.
pub const OPENER_SPECIFIC: i32 = 100;

#[derive(Default)]
pub struct PanelFactories {
    constructors: BTreeMap<PanelKind, Constructor>,
    /// The kind with the highest priority that claims a target opens it; of
    /// equal priority, the first registered.
    openers: Vec<(PanelKind, i32, Opener)>,
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
        self.register_opener_with(kind, OPENER_DEFAULT, opens);
    }

    /// As [`register_opener`](Self::register_opener), with a priority: when
    /// several kinds claim a target the highest wins whatever the order they
    /// were registered in. A specific opener (Markdown for `.md`) registers
    /// at [`OPENER_SPECIFIC`]; a catch-all editor at the default.
    pub fn register_opener_with(
        &mut self,
        kind: &str,
        priority: i32,
        opens: impl Fn(&OpenTarget) -> bool + 'static,
    ) {
        let kind = PanelKind::new(kind);
        self.openers.retain(|(k, _, _)| *k != kind);
        self.openers.push((kind, priority, Box::new(opens)));
    }

    /// The kind that opens `target`, if any is registered.
    pub fn opener_of(&self, target: &OpenTarget) -> Option<&PanelKind> {
        // `max_by_key` keeps the last of equals; reverse so the first wins.
        self.openers
            .iter()
            .rev()
            .filter(|(_, _, opens)| opens(target))
            .max_by_key(|(_, priority, _)| *priority)
            .map(|(kind, _, _)| kind)
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
