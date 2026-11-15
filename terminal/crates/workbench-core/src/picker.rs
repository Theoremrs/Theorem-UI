//! The tool picker's own state machine (spec 5, R07). Opening, filtering,
//! moving and closing it produce no effects: [`Picker::update`] returns only an
//! outcome, and the one thing it can return that matters is the id of the
//! action a person chose. What that action does is the registry's word.
//!
//! Where rows are drawn is [`crate::picker_layout`]'s word; the moves that
//! depend on it (Left and Right across two columns) ask it, with the cells the
//! host last gave the picker, so the keyboard follows what is on screen.

use std::collections::{BTreeMap, BTreeSet};

use ratatui::layout::Rect;

use crate::ids::{ActionId, PanelKind};
use crate::panel::PickerView;
use crate::picker_layout::Layout;
use crate::registry::{Availability, Capabilities, PickerRow, Registry};

/// The row that leads to the rest of the tools instead of choosing one.
pub const MORE_TOOLS: &str = "picker.more";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Main,
    More,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickerMsg {
    Open,
    /// Escape: back from More tools first, then close.
    Back,
    Close,
    Filter(String),
    Next,
    Prev,
    /// With two columns showing, the row beside this one in the other column.
    /// In the first column (or one) on More tools: back.
    Left,
    Right,
    Choose,
    /// A pointer is over row `n` of the rows now showing: select it. Out of
    /// range does nothing.
    Select(usize),
    /// A pointer click on row `n`: select it, then choose it as `Choose` does.
    ChooseAt(usize),
    /// Pin the selected More tools entry to the main rows, or unpin it.
    TogglePin,
    /// The same for row `n`, from a pointer click on its pin control.
    TogglePinAt(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickerOutcome {
    Nothing,
    /// The picker closed with nothing chosen.
    Closed,
    /// A row was chosen. The picker has closed; resolve the action through the
    /// registry.
    Chosen(ActionId),
    /// An unavailable row was chosen. The picker stays open and says why.
    Unavailable {
        reason: String,
    },
    /// The tool is to be pinned (or unpinned). The picker stays open; the
    /// caller owns the pins.
    Pin {
        panel: PanelKind,
        pinned: bool,
    },
}

#[derive(Clone, Debug)]
pub struct Picker {
    open: bool,
    page: Page,
    filter: String,
    selected: usize,
    /// Why the last row chosen was refused, until the selection moves.
    reason: Option<String>,
    /// What the host gives the picker: the cells its body has and the chords
    /// the active key bindings give its actions. They outlive a close.
    area: Rect,
    shortcuts: BTreeMap<ActionId, String>,
}

impl Default for Picker {
    fn default() -> Self {
        Self {
            open: false,
            page: Page::Main,
            filter: String::new(),
            selected: 0,
            reason: None,
            area: Rect::default(),
            shortcuts: BTreeMap::new(),
        }
    }
}

impl Picker {
    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn page(&self) -> Page {
        self.page
    }

    /// The text the rows are narrowed by.
    pub fn filter(&self) -> &str {
        &self.filter
    }

    pub fn selected(&self) -> usize {
        self.selected
    }

    /// Why the last row chosen could not be opened. Cleared when the selection
    /// moves, the filter changes or the page turns.
    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }

    /// The cells the picker's body has now.
    pub fn set_area(&mut self, area: Rect) {
        self.area = area;
    }

    /// The chords the active key bindings give actions, as people read them.
    /// A row whose action has none shows no hint.
    pub fn set_shortcuts(&mut self, shortcuts: BTreeMap<ActionId, String>) {
        self.shortcuts = shortcuts;
    }

    /// The rows now showing: this page's, narrowed by the filter, each with the
    /// chord its action has.
    pub fn rows(
        &self,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> Vec<PickerRow> {
        let rows = match self.page {
            Page::Main => registry.picker_rows(caps, pinned),
            Page::More => registry.more_tools(caps, pinned),
        };
        let needle = self.filter.to_lowercase();
        rows.into_iter()
            .filter(|r| r.title.to_lowercase().contains(&needle))
            .map(|mut r| {
                r.shortcut = self.shortcuts.get(&r.action).cloned();
                r
            })
            .collect()
    }

    /// What the picker panel is given to draw.
    pub fn view(
        &self,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerView {
        PickerView {
            rows: self.rows(registry, caps, pinned),
            selected: self.selected,
            filter: self.filter.clone(),
            more: self.page == Page::More,
            reason: self.reason.clone(),
        }
    }

    /// Keep the selection on a row after the rows changed under it.
    pub fn clamp(
        &mut self,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) {
        let n = self.rows(registry, caps, pinned).len();
        self.selected = self.selected.min(n.saturating_sub(1));
    }

    fn reset(&mut self) {
        *self = Self {
            area: self.area,
            shortcuts: std::mem::take(&mut self.shortcuts),
            ..Self::default()
        };
    }

    fn select(&mut self, index: usize) {
        if index != self.selected {
            self.selected = index;
            self.reason = None;
        }
    }

    pub fn update(
        &mut self,
        msg: PickerMsg,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerOutcome {
        match msg {
            PickerMsg::Open => {
                self.reset();
                self.open = true;
                PickerOutcome::Nothing
            }
            PickerMsg::Back if self.open && self.page == Page::More => {
                self.page = Page::Main;
                self.filter.clear();
                self.selected = 0;
                self.reason = None;
                PickerOutcome::Nothing
            }
            PickerMsg::Back | PickerMsg::Close => {
                let was_open = self.open;
                self.reset();
                if was_open {
                    PickerOutcome::Closed
                } else {
                    PickerOutcome::Nothing
                }
            }
            PickerMsg::Filter(text) if self.open => {
                self.filter = text;
                self.selected = 0;
                self.reason = None;
                PickerOutcome::Nothing
            }
            PickerMsg::Next if self.open => {
                let n = self.rows(registry, caps, pinned).len();
                if n > 0 {
                    self.select((self.selected + 1) % n);
                }
                PickerOutcome::Nothing
            }
            PickerMsg::Prev if self.open => {
                let n = self.rows(registry, caps, pinned).len();
                if n > 0 {
                    self.select((self.selected + n - 1) % n);
                }
                PickerOutcome::Nothing
            }
            PickerMsg::Left | PickerMsg::Right if self.open => {
                let view = self.view(registry, caps, pinned);
                let layout = Layout::compute(&view, self.area);
                let (n, per) = (view.rows.len(), layout.per_column);
                let here = self.selected.min(n.saturating_sub(1));
                if n == 0 {
                    return self.step_back_if_left(&msg, registry, caps, pinned);
                }
                let target = match msg {
                    PickerMsg::Left if layout.columns == 2 && here >= per => Some(here - per),
                    PickerMsg::Right if layout.columns == 2 && here < per => {
                        Some((here + per).min(n - 1))
                    }
                    _ => None,
                };
                match target {
                    Some(t) => {
                        self.select(t);
                        PickerOutcome::Nothing
                    }
                    None => self.step_back_if_left(&msg, registry, caps, pinned),
                }
            }
            PickerMsg::Select(row) if self.open => {
                if row < self.rows(registry, caps, pinned).len() {
                    self.select(row);
                }
                PickerOutcome::Nothing
            }
            PickerMsg::ChooseAt(row) if self.open => {
                if row >= self.rows(registry, caps, pinned).len() {
                    return PickerOutcome::Nothing;
                }
                self.select(row);
                self.update(PickerMsg::Choose, registry, caps, pinned)
            }
            PickerMsg::TogglePin if self.open => {
                self.toggle_pin(self.selected, registry, caps, pinned)
            }
            PickerMsg::TogglePinAt(row) if self.open => {
                self.select(row.min(self.rows(registry, caps, pinned).len().saturating_sub(1)));
                self.toggle_pin(row, registry, caps, pinned)
            }
            PickerMsg::Choose if self.open => {
                let rows = self.rows(registry, caps, pinned);
                let Some(row) = rows.get(self.selected) else {
                    return PickerOutcome::Nothing;
                };
                if let Availability::Unavailable { reason } = &row.availability {
                    self.reason = Some(reason.clone());
                    return PickerOutcome::Unavailable {
                        reason: reason.clone(),
                    };
                }
                if row.action.as_str() == MORE_TOOLS {
                    self.page = Page::More;
                    self.filter.clear();
                    self.selected = 0;
                    self.reason = None;
                    return PickerOutcome::Nothing;
                }
                let chosen = row.action.clone();
                self.reset();
                PickerOutcome::Chosen(chosen)
            }
            // A message to a closed picker does nothing.
            PickerMsg::Filter(_)
            | PickerMsg::Next
            | PickerMsg::Prev
            | PickerMsg::Left
            | PickerMsg::Right
            | PickerMsg::Choose
            | PickerMsg::Select(_)
            | PickerMsg::ChooseAt(_)
            | PickerMsg::TogglePin
            | PickerMsg::TogglePinAt(_) => PickerOutcome::Nothing,
        }
    }

    /// Left with nowhere further left to go on More tools goes back.
    fn step_back_if_left(
        &mut self,
        msg: &PickerMsg,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerOutcome {
        if *msg == PickerMsg::Left && self.page == Page::More {
            self.update(PickerMsg::Back, registry, caps, pinned)
        } else {
            PickerOutcome::Nothing
        }
    }

    fn toggle_pin(
        &mut self,
        row: usize,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerOutcome {
        let rows = self.rows(registry, caps, pinned);
        match rows.get(row) {
            Some(r) if r.pinnable => {
                self.reason = None;
                PickerOutcome::Pin {
                    panel: r.panel.clone(),
                    pinned: !r.pinned,
                }
            }
            _ => PickerOutcome::Nothing,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin::registry;
    use crate::ids::Actor;
    use crate::registry::{ActionIntent, PickerSlot, Refusal};

    fn all_caps() -> Capabilities {
        Capabilities::of([
            "files",
            "documents",
            "scm",
            "language",
            "run",
            "search",
            "environment",
            "artifacts",
            "conversation",
            "terminal.native",
            "terminal.herdr",
        ])
    }

    fn no_pins() -> BTreeSet<PanelKind> {
        BTreeSet::new()
    }

    #[test]
    fn the_main_rows_are_the_six_the_spec_names_in_order() {
        let reg = registry();
        let rows = reg.picker_rows(&all_caps(), &no_pins());
        let titles: Vec<_> = rows.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Changes",
                "Shell",
                "Files",
                "Side chat",
                "New page",
                "More tools"
            ]
        );
    }

    #[test]
    fn unavailable_rows_stay_listed_with_a_reason() {
        let reg = registry();
        let caps = Capabilities::of(["files"]);
        let rows = reg.picker_rows(&caps, &no_pins());
        assert_eq!(rows.len(), 6);
        let shell = rows.iter().find(|r| r.title == "Shell").unwrap();
        let Availability::Unavailable { reason } = &shell.availability else {
            panic!("shell should be unavailable")
        };
        assert!(reason.contains("environment"));
        assert!(
            rows.iter()
                .find(|r| r.title == "Files")
                .unwrap()
                .availability
                .is_available()
        );
    }

    /// AC-06: open, filter, navigate, descend into More tools, back, close:
    /// the picker never produces anything but an outcome, and no outcome is a
    /// choice until a row is chosen.
    #[test]
    fn browsing_the_picker_chooses_nothing() {
        let reg = registry();
        let caps = all_caps();
        let pins = no_pins();
        let mut picker = Picker::default();
        let script = [
            PickerMsg::Open,
            PickerMsg::Next,
            PickerMsg::Prev,
            PickerMsg::Filter("sh".into()),
            PickerMsg::Filter(String::new()),
            PickerMsg::Next,
            PickerMsg::Next,
            PickerMsg::Next,
            PickerMsg::Next,
            PickerMsg::Next,   // lands on More tools
            PickerMsg::Choose, // descends, chooses nothing
            PickerMsg::Next,
            PickerMsg::Back,
            PickerMsg::Back, // closes
            PickerMsg::Open,
            PickerMsg::Close,
            PickerMsg::Select(2),
            PickerMsg::ChooseAt(1),
            PickerMsg::Open,
            PickerMsg::Select(2),
            PickerMsg::Select(99),
            PickerMsg::ChooseAt(99),
            PickerMsg::Close,
        ];
        for msg in script {
            let outcome = picker.update(msg.clone(), &reg, &caps, &pins);
            assert!(
                !matches!(outcome, PickerOutcome::Chosen(_)),
                "{msg:?} must not choose anything"
            );
        }
        assert!(!picker.is_open());
    }

    #[test]
    fn pointer_selection_moves_the_highlight_and_a_click_chooses() {
        let reg = registry();
        let (caps, pins) = (all_caps(), no_pins());
        let mut picker = Picker::default();
        // A closed picker ignores the pointer.
        assert_eq!(
            picker.update(PickerMsg::ChooseAt(1), &reg, &caps, &pins),
            PickerOutcome::Nothing
        );
        picker.update(PickerMsg::Open, &reg, &caps, &pins);
        picker.update(PickerMsg::Select(3), &reg, &caps, &pins);
        assert_eq!(picker.selected(), 3);
        // Past the last row nothing moves.
        picker.update(PickerMsg::Select(40), &reg, &caps, &pins);
        assert_eq!(picker.selected(), 3);
        assert_eq!(
            picker.update(PickerMsg::ChooseAt(40), &reg, &caps, &pins),
            PickerOutcome::Nothing
        );
        assert!(picker.is_open() && picker.selected() == 3);
        let outcome = picker.update(PickerMsg::ChooseAt(1), &reg, &caps, &pins);
        assert_eq!(
            outcome,
            PickerOutcome::Chosen(ActionId::new("shell.choose"))
        );
        assert!(!picker.is_open());
    }

    #[test]
    fn a_click_on_more_tools_descends_and_on_an_unavailable_row_explains() {
        let reg = registry();
        let (caps, pins) = (all_caps(), no_pins());
        let mut picker = Picker::default();
        picker.update(PickerMsg::Open, &reg, &caps, &pins);
        assert_eq!(
            picker.update(PickerMsg::ChooseAt(5), &reg, &caps, &pins),
            PickerOutcome::Nothing
        );
        assert_eq!(picker.page(), Page::More);

        let few = Capabilities::of(["files"]);
        let mut picker = Picker::default();
        picker.update(PickerMsg::Open, &reg, &few, &pins);
        assert!(matches!(
            picker.update(PickerMsg::ChooseAt(1), &reg, &few, &pins),
            PickerOutcome::Unavailable { .. }
        ));
        assert!(picker.is_open());
    }

    #[test]
    fn choosing_a_row_returns_its_action_and_closes() {
        let reg = registry();
        let (caps, pins) = (all_caps(), no_pins());
        let mut picker = Picker::default();
        picker.update(PickerMsg::Open, &reg, &caps, &pins);
        picker.update(PickerMsg::Next, &reg, &caps, &pins); // Shell
        let outcome = picker.update(PickerMsg::Choose, &reg, &caps, &pins);
        assert_eq!(
            outcome,
            PickerOutcome::Chosen(ActionId::new("shell.choose"))
        );
        assert!(!picker.is_open());
    }

    #[test]
    fn choosing_an_unavailable_row_explains_and_stays_open() {
        let reg = registry();
        let (caps, pins) = (Capabilities::of(["files"]), no_pins());
        let mut picker = Picker::default();
        picker.update(PickerMsg::Open, &reg, &caps, &pins);
        picker.update(PickerMsg::Next, &reg, &caps, &pins); // Shell
        let outcome = picker.update(PickerMsg::Choose, &reg, &caps, &pins);
        assert!(matches!(outcome, PickerOutcome::Unavailable { .. }));
        assert!(picker.is_open());
    }

    #[test]
    fn more_tools_lists_the_rest_and_pinning_moves_a_tool_to_the_main_rows() {
        let reg = registry();
        let caps = all_caps();
        let more = reg.more_tools(&caps, &no_pins());
        let titles: Vec<_> = more.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(
            titles,
            [
                "Artifacts",
                "Diagnostics",
                "Run output",
                "Search",
                "History"
            ]
        );

        let pins: BTreeSet<_> = [PanelKind::new("cabinet")].into();
        let main = reg.picker_rows(&caps, &pins);
        // After the initial rows, before the row that leads to More tools.
        let titles: Vec<_> = main.iter().map(|r| r.title.as_str()).collect();
        assert_eq!(titles[5..], ["Artifacts", "More tools"]);
        assert!(main[5].pinned);
        assert!(
            !reg.more_tools(&caps, &pins)
                .iter()
                .any(|r| r.title == "Artifacts")
        );
    }

    /// AC-06 and R07, over the whole registry: every row in the picker is a
    /// Focus or Open action that emits no effect; only Create, Start and
    /// Destroy actions name one.
    #[test]
    fn only_create_start_destroy_can_produce_a_domain_effect() {
        let reg = registry();
        let caps = all_caps();
        let pins = no_pins();
        for row in reg
            .picker_rows(&caps, &pins)
            .into_iter()
            .chain(reg.more_tools(&caps, &pins))
        {
            assert!(
                matches!(row.intent, ActionIntent::Focus | ActionIntent::Open),
                "picker row {:?} must not create, start or destroy",
                row.action
            );
            let resolved = reg.resolve(&row.action, &Actor::Human, &caps).unwrap();
            assert_eq!(resolved.emits(), None);
        }
        for panel in reg.panels() {
            for action in &panel.actions {
                assert_eq!(
                    action.emits.is_some(),
                    action.intent.may_emit_effect(),
                    "{:?}: an effect exactly when the intent allows one",
                    action.id
                );
            }
        }
        // The effects are reachable only by explicit action ids, not by rows.
        for id in [
            "page.create",
            "shell.start",
            "shell.end",
            "side-chat.create",
        ] {
            let resolved = reg
                .resolve(&ActionId::new(id), &Actor::Human, &caps)
                .unwrap();
            assert!(resolved.emits().is_some(), "{id}");
            assert!(
                resolved.action.picker.is_none()
                    || matches!(resolved.action.picker, Some(PickerSlot::More))
            );
        }
    }

    #[test]
    fn an_agent_cannot_approve() {
        let reg = registry();
        let caps = all_caps();
        let agent = Actor::Agent {
            run_id: "run-1".into(),
        };
        let refused = reg
            .resolve(&ActionId::new("approval.allow"), &agent, &caps)
            .err();
        assert_eq!(
            refused,
            Some(Refusal::HumanOnly(ActionId::new("approval.allow")))
        );
        assert!(
            reg.resolve(&ActionId::new("approval.allow"), &Actor::Human, &caps)
                .is_ok()
        );
        let catalog = reg.agent_catalog(&caps);
        assert!(
            !catalog
                .iter()
                .any(|e| e.action.as_str().starts_with("approval."))
        );
        assert!(catalog.iter().any(|e| e.action.as_str() == "changes.open"));
    }
}
