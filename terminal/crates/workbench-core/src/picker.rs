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
use theorem_workbench_text::visible::visible;

use crate::arrangement::{ARRANGEMENT_NAME_CHARS, ArrangementInfo, preset_named};
use crate::ids::{ActionId, PanelKind};
use crate::panel::PickerView;
use crate::panels::WORKBENCH_KIND;
use crate::picker_layout::Layout;
use crate::presentation::PRESENTATION_USE;
use crate::registry::{ActionIntent, Availability, Capabilities, Chooses, PickerRow, Registry};

/// The row that leads to the rest of the tools instead of choosing one.
pub const MORE_TOOLS: &str = "picker.more";
/// The row that leads to the layouts: the built-in presets and the account's
/// saved arrangements.
pub const LAYOUTS: &str = "workbench.layouts";
/// The Layouts page's rename and delete, by name: they act on the highlighted
/// saved layout.
pub const LAYOUT_RENAME: &str = "picker.layout.rename";
pub const LAYOUT_DELETE: &str = "picker.layout.delete";
/// The Layouts page's last row, and the workbench action it stands for: ask
/// for a name and keep the arrangement as it is under it.
pub const LAYOUT_SAVE: &str = "workbench.layout.save";
/// The prefix of a layout row's semantic action; the layout's name follows.
/// The mark after a saved arrangement's name when applying it changes the
/// appearance too. It rides in the row's hint cell, so it is muted and is the
/// first thing to go at a narrow width.
pub const THEME_MARK: &str = "theme";
pub const LAYOUT_APPLY: &str = "picker.layout.apply:";
/// Leads the rows that are the account's own, not built in.
const SAVED_MARK: &str = "\u{25a0}";
/// The Layouts page's heading.
pub const HEADING_LAYOUTS: &str = "Layouts";
/// The presentation chooser's heading.
pub const HEADING_PRESENTATIONS: &str = "Show as";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Page {
    Main,
    More,
    /// The built-in presets, then the saved arrangements, then "Save layout
    /// as…".
    Layouts,
    /// A one-line name entry (the filter line is the entry); `entry` says what
    /// for.
    Name,
    /// The ways to show the document a panel is bound to (R48, AC-59).
    Presentations,
}

/// What a name is being asked for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NameFor {
    Save,
    Rename(String),
}

/// What the Layouts page asks the root to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LayoutChoice {
    Apply(String),
    Save(String),
    Rename { from: String, to: String },
    Delete(String),
}

#[derive(Clone, PartialEq, Eq)]
pub enum PickerMsg {
    Open,
    /// Show the picker without taking the keyboard.
    Rest,
    /// A resting picker takes the keyboard (its chord, a click, focus moving
    /// to it). Nothing when it is not resting.
    Take,
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
    /// The chord printed on a row was pressed: choose that row, on whichever
    /// page it is, exactly as Enter on it would. Nothing when no available row
    /// has this action.
    ChooseRow(ActionId),
    /// The Layouts page (from any page of an open picker).
    Layouts,
    /// The presentation chooser (from any page of an open picker).
    Presentations,
    /// Ask for a name to save the arrangement under.
    SaveAs,
    /// Ask for a new name for the highlighted saved arrangement.
    RenameSelected,
    /// Ask once, then delete the highlighted saved arrangement.
    DeleteSelected,
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
    /// A layout row or the name entry was confirmed. The picker has closed
    /// for `Apply` and `Save`, and stays on the Layouts page for the others.
    Layout(LayoutChoice),
    /// A presentation row was chosen. The picker has closed; the root swaps
    /// the panel the chooser was opened for.
    Presentation(PanelKind),
}

#[derive(Clone, Debug)]
pub struct Picker {
    open: bool,
    /// Shown but not holding the keyboard: the picker as the tool
    /// destination's first content. `open` is also true.
    resting: bool,
    page: Page,
    filter: String,
    selected: usize,
    /// Why the last row chosen was refused, until the selection moves.
    reason: Option<String>,
    /// What the host gives the picker: the cells its body has and the chords
    /// the active key bindings give its actions. They outlive a close.
    area: Rect,
    shortcuts: BTreeMap<ActionId, String>,
    pin_shortcut: Option<String>,
    /// The layouts the Layouts page lists (the model keeps them current).
    layouts: Vec<ArrangementInfo>,
    /// What the name entry is for, while it is showing.
    naming: Option<NameFor>,
    /// Escape from the name entry goes back to the Layouts page, not out.
    name_from_layouts: bool,
    /// The saved arrangement a delete is waiting to be confirmed for.
    confirm: Option<String>,
    /// The rows the presentation chooser lists.
    presentations: Vec<PickerRow>,
}

impl Default for Picker {
    fn default() -> Self {
        Self {
            open: false,
            resting: false,
            page: Page::Main,
            filter: String::new(),
            selected: 0,
            reason: None,
            area: Rect::default(),
            shortcuts: BTreeMap::new(),
            pin_shortcut: None,
            layouts: Vec::new(),
            naming: None,
            name_from_layouts: false,
            confirm: None,
            presentations: Vec::new(),
        }
    }
}

impl Picker {
    /// Shown, whether or not it holds the keyboard.
    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Shown and not holding the keyboard.
    pub fn is_resting(&self) -> bool {
        self.open && self.resting
    }

    /// Open and owning the keys: the modal state.
    pub fn holds_keys(&self) -> bool {
        self.open && !self.resting
    }

    pub fn page(&self) -> Page {
        self.page
    }

    /// What the name entry is asking for, while it is showing.
    pub fn naming(&self) -> Option<&NameFor> {
        self.naming.as_ref()
    }

    /// The layouts the model last gave the picker.
    pub fn set_layouts(&mut self, layouts: Vec<ArrangementInfo>) {
        self.layouts = layouts;
    }

    /// The rows the presentation chooser lists.
    pub fn set_presentations(&mut self, rows: Vec<PickerRow>) {
        self.presentations = rows;
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

    /// The chord the active bindings give pinning, shown beside the selected
    /// row's pin mark when it fits.
    pub fn set_pin_shortcut(&mut self, chord: Option<String>) {
        self.pin_shortcut = chord;
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
            Page::Layouts => self.layout_rows(),
            Page::Presentations => self.presentations.clone(),
            Page::Name => Vec::new(),
        };
        let needle = self.filter.to_lowercase();
        rows.into_iter()
            .filter(|r| r.title.to_lowercase().contains(&needle))
            .map(|mut r| {
                // A layout row's hint cell is its theme mark, set when it was
                // built; every other row's is its chord.
                if self.page != Page::Layouts {
                    r.shortcut = self.shortcuts.get(&r.action).cloned();
                }
                r
            })
            .collect()
    }

    /// The page and place of the available row whose action is `action`, on
    /// the main page (pinned tools included) or under More tools.
    fn row_position(
        &self,
        action: &ActionId,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> Option<(Page, usize)> {
        [
            (Page::Main, registry.picker_rows(caps, pinned)),
            (Page::More, registry.more_tools(caps, pinned)),
        ]
        .into_iter()
        .find_map(|(page, rows)| {
            rows.iter()
                .position(|r| &r.action == action)
                .filter(|&at| rows[at].availability == Availability::Available)
                .map(|at| (page, at))
        })
    }

    /// Whether an available row offers `action` (on any page): the chord
    /// printed on it chooses it while the picker holds the keys.
    pub fn offers(
        &self,
        action: &ActionId,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> bool {
        self.row_position(action, registry, caps, pinned).is_some()
    }

    fn layout_rows(&self) -> Vec<PickerRow> {
        let row = |action: String,
                   title: String,
                   glyph: Option<String>,
                   shortcut: Option<String>| PickerRow {
            action: ActionId::new(action),
            panel: PanelKind::new(WORKBENCH_KIND),
            title,
            intent: ActionIntent::Open,
            availability: Availability::Available,
            pinned: false,
            chooses: Chooses::Opens,
            pinnable: false,
            shortcut,
            glyph,
        };
        let mut rows: Vec<PickerRow> = self
            .layouts
            .iter()
            .map(|l| {
                row(
                    format!("{LAYOUT_APPLY}{}", l.name),
                    l.name.clone(),
                    (!l.builtin).then(|| SAVED_MARK.to_owned()),
                    l.themed.then(|| THEME_MARK.to_owned()),
                )
            })
            .collect();
        rows.push(row(
            LAYOUT_SAVE.to_owned(),
            "Save layout as\u{2026}".into(),
            None,
            None,
        ));
        rows
    }

    /// The saved (not built-in) arrangement the selected row is, or why the
    /// row is not one.
    fn selected_saved(&self, verb: &str, rows: &[PickerRow]) -> Result<String, String> {
        let name = rows
            .get(self.selected)
            .and_then(|r| r.action.as_str().strip_prefix(LAYOUT_APPLY))
            .ok_or_else(|| format!("Highlight a saved layout to {verb} first."))?;
        match self.layouts.iter().find(|l| l.name == name) {
            Some(l) if l.builtin => Err(format!(
                "\"{name}\" is built in. Built-in layouts cannot be {verb}d."
            )),
            Some(_) => Ok(name.to_owned()),
            None => Err(format!("Highlight a saved layout to {verb} first.")),
        }
    }

    /// Why `name` cannot be used for what is being asked, in words for the
    /// entry row; `None` when it can.
    fn name_problem(&self, name: &str) -> Option<String> {
        let name = name.trim();
        if name.is_empty() {
            return Some("A name is needed.".into());
        }
        if name.chars().count() > ARRANGEMENT_NAME_CHARS {
            return Some(format!(
                "A name is at most {ARRANGEMENT_NAME_CHARS} characters."
            ));
        }
        if preset_named(name).is_some() {
            return Some(format!(
                "\"{name}\" is a built-in layout. Choose another name."
            ));
        }
        if let Some(NameFor::Rename(from)) = &self.naming {
            let key = name.to_lowercase();
            let taken = self
                .layouts
                .iter()
                .any(|l| l.name.to_lowercase() == key && l.name != *from);
            if taken {
                return Some(format!("\"{name}\" is already a saved layout."));
            }
        }
        None
    }

    /// What the picker panel is given to draw.
    pub fn view(
        &self,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerView {
        // Layout names and reasons are shown, never typed: spelled out.
        let mut rows = self.rows(registry, caps, pinned);
        rows.iter_mut().for_each(|r| r.title = visible(&r.title));
        PickerView {
            rows,
            selected: self.selected,
            filter: self.filter.clone(),
            more: self.page != Page::Main,
            heading: match self.page {
                Page::Layouts | Page::Name => Some(HEADING_LAYOUTS.to_owned()),
                Page::Presentations => Some(HEADING_PRESENTATIONS.to_owned()),
                Page::Main | Page::More => None,
            },
            entry: self.naming.as_ref().map(|n| match n {
                NameFor::Save => "Save layout as".to_owned(),
                NameFor::Rename(from) => visible(&format!("Rename \"{from}\" to")),
            }),
            reason: self.reason.as_deref().map(visible),
            pin_shortcut: self.pin_shortcut.clone(),
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
            pin_shortcut: self.pin_shortcut.take(),
            layouts: std::mem::take(&mut self.layouts),
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
        // A delete waits for its confirming Enter; anything else withdraws it.
        if self.confirm.is_some()
            && !matches!(
                msg,
                PickerMsg::Choose | PickerMsg::Close | PickerMsg::Open | PickerMsg::Rest
            )
        {
            self.confirm = None;
            self.reason = None;
            if msg == PickerMsg::Back {
                return PickerOutcome::Nothing;
            }
        }
        match msg {
            PickerMsg::Open => {
                self.reset();
                self.open = true;
                PickerOutcome::Nothing
            }
            PickerMsg::Rest => {
                self.reset();
                self.open = true;
                self.resting = true;
                PickerOutcome::Nothing
            }
            PickerMsg::Take => {
                self.resting = false;
                PickerOutcome::Nothing
            }
            PickerMsg::Back if self.open && self.page == Page::Name => {
                self.naming = None;
                self.filter.clear();
                self.selected = 0;
                self.reason = None;
                if std::mem::take(&mut self.name_from_layouts) {
                    self.page = Page::Layouts;
                    PickerOutcome::Nothing
                } else {
                    self.reset();
                    PickerOutcome::Closed
                }
            }
            PickerMsg::Back if self.open && self.page == Page::Layouts => {
                self.page = Page::Main;
                self.filter.clear();
                self.selected = 0;
                self.reason = None;
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
            PickerMsg::Next | PickerMsg::Prev if self.open => {
                let view = self.view(registry, caps, pinned);
                let columns = usize::from(Layout::compute(&view, self.area).columns);
                let n = view.rows.len();
                if n > 0 {
                    let here = self.selected.min(n - 1);
                    self.select(grid_step(n, columns, here, msg == PickerMsg::Next));
                }
                PickerOutcome::Nothing
            }
            PickerMsg::Left | PickerMsg::Right if self.open => {
                let view = self.view(registry, caps, pinned);
                let layout = Layout::compute(&view, self.area);
                let n = view.rows.len();
                let here = self.selected.min(n.saturating_sub(1));
                if n == 0 {
                    return self.step_back_if_left(&msg, registry, caps, pinned);
                }
                let target = match msg {
                    PickerMsg::Left if layout.columns == 2 && here % 2 == 1 => Some(here - 1),
                    PickerMsg::Right
                        if layout.columns == 2 && here.is_multiple_of(2) && here + 1 < n =>
                    {
                        Some(here + 1)
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
            PickerMsg::ChooseRow(action) if self.open => {
                match self.row_position(&action, registry, caps, pinned) {
                    Some((page, at)) => {
                        self.page = page;
                        self.filter.clear();
                        self.selected = at;
                        self.reason = None;
                        self.naming = None;
                        self.update(PickerMsg::Choose, registry, caps, pinned)
                    }
                    None => PickerOutcome::Nothing,
                }
            }
            PickerMsg::Layouts if self.open => {
                self.page = Page::Layouts;
                self.naming = None;
                self.filter.clear();
                self.selected = 0;
                self.reason = None;
                PickerOutcome::Nothing
            }
            PickerMsg::Presentations if self.open => {
                self.page = Page::Presentations;
                self.naming = None;
                self.filter.clear();
                self.selected = self
                    .presentations
                    .iter()
                    .position(|r| r.glyph.is_some())
                    .unwrap_or(0);
                self.reason = None;
                PickerOutcome::Nothing
            }
            PickerMsg::SaveAs if self.open => {
                self.start_name(NameFor::Save, String::new());
                PickerOutcome::Nothing
            }
            PickerMsg::RenameSelected if self.open && self.page == Page::Layouts => {
                let rows = self.rows(registry, caps, pinned);
                match self.selected_saved("rename", &rows) {
                    Ok(name) => {
                        self.start_name(NameFor::Rename(name.clone()), name);
                        PickerOutcome::Nothing
                    }
                    Err(reason) => {
                        self.reason = Some(reason.clone());
                        PickerOutcome::Unavailable { reason }
                    }
                }
            }
            PickerMsg::DeleteSelected if self.open && self.page == Page::Layouts => {
                let rows = self.rows(registry, caps, pinned);
                match self.selected_saved("delete", &rows) {
                    Ok(name) => {
                        self.reason = Some(format!(
                            "Delete \"{name}\"? Enter deletes it; any other key keeps it."
                        ));
                        self.confirm = Some(name);
                        PickerOutcome::Nothing
                    }
                    Err(reason) => {
                        self.reason = Some(reason.clone());
                        PickerOutcome::Unavailable { reason }
                    }
                }
            }
            PickerMsg::Choose if self.open && self.confirm.is_some() => {
                let name = self.confirm.take().unwrap_or_default();
                self.reason = None;
                PickerOutcome::Layout(LayoutChoice::Delete(name))
            }
            PickerMsg::Choose if self.open && self.page == Page::Name => {
                if let Some(problem) = self.name_problem(&self.filter) {
                    self.reason = Some(problem.clone());
                    return PickerOutcome::Unavailable { reason: problem };
                }
                let name = self.filter.trim().to_owned();
                match self.naming.take() {
                    Some(NameFor::Rename(from)) => {
                        self.page = Page::Layouts;
                        self.filter.clear();
                        self.selected = 0;
                        self.reason = None;
                        PickerOutcome::Layout(LayoutChoice::Rename { from, to: name })
                    }
                    _ => {
                        self.reset();
                        PickerOutcome::Layout(LayoutChoice::Save(name))
                    }
                }
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
                if self.page == Page::Presentations {
                    let kind = row
                        .action
                        .as_str()
                        .strip_prefix(PRESENTATION_USE)
                        .unwrap_or_default()
                        .to_owned();
                    self.reset();
                    return PickerOutcome::Presentation(PanelKind::new(kind));
                }
                if self.page == Page::Layouts {
                    let action = row.action.as_str().to_owned();
                    if action == LAYOUT_SAVE {
                        self.start_name(NameFor::Save, String::new());
                        return PickerOutcome::Nothing;
                    }
                    let name = action
                        .strip_prefix(LAYOUT_APPLY)
                        .unwrap_or_default()
                        .to_owned();
                    self.reset();
                    return PickerOutcome::Layout(LayoutChoice::Apply(name));
                }
                if row.action.as_str() == LAYOUTS {
                    self.page = Page::Layouts;
                    self.filter.clear();
                    self.selected = 0;
                    self.reason = None;
                    return PickerOutcome::Nothing;
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
            | PickerMsg::ChooseRow(_)
            | PickerMsg::Layouts
            | PickerMsg::Presentations
            | PickerMsg::SaveAs
            | PickerMsg::RenameSelected
            | PickerMsg::DeleteSelected
            | PickerMsg::TogglePin
            | PickerMsg::TogglePinAt(_) => PickerOutcome::Nothing,
        }
    }

    /// Show the name entry for `what`, starting from `text`.
    fn start_name(&mut self, what: NameFor, text: String) {
        self.name_from_layouts = self.page == Page::Layouts;
        self.page = Page::Name;
        self.naming = Some(what);
        self.filter = text;
        self.selected = 0;
        self.reason = None;
    }

    /// Left with nowhere further left to go on More tools goes back.
    fn step_back_if_left(
        &mut self,
        msg: &PickerMsg,
        registry: &Registry,
        caps: &Capabilities,
        pinned: &BTreeSet<PanelKind>,
    ) -> PickerOutcome {
        if *msg == PickerMsg::Left && matches!(self.page, Page::More | Page::Layouts) {
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

/// Down (or Up) in the grid the rows are drawn in: within the column, wrapping
/// from the last row of the column to the first and back. One column steps
/// through every row.
fn grid_step(n: usize, columns: usize, here: usize, down: bool) -> usize {
    let columns = columns.max(1);
    if down {
        if here + columns < n {
            here + columns
        } else {
            here % columns
        }
    } else if here >= columns {
        here - columns
    } else {
        // The last row of this column: the largest index with the same column.
        let mut last = here;
        while last + columns < n {
            last += columns;
        }
        last
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
            "conversation.side",
            "conversation.attach",
            "conversation.model",
            "diagnostics.subscribe",
            "run.start",
            "run.subscribe",
            "search.query",
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
                "History",
                "Layouts"
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
            assert!(resolved.emits().is_empty());
        }
        for panel in reg.panels() {
            for action in &panel.actions {
                assert_eq!(
                    !action.emits.is_empty(),
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
            assert!(!resolved.emits().is_empty(), "{id}");
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
            Some(Refusal::HumanOnly {
                action: ActionId::new("approval.allow"),
                actor: agent.clone(),
            })
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
