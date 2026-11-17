//! The agent terminal drawer's TUI. React owns the agent (an assistant-ui
//! runtime on its own Theorem thread) and pushes the transcript in as JSON.
//! This crate draws it with Ratatui on Ratzilla's DOM backend, edits the
//! prompt line, and hands what the person asked for back as actions.
//!
//! Keys, paste and wheel arrive through `TerminalHandle` from a container
//! React keeps, not through Ratzilla's own key listener: the DOM backend
//! rebuilds its grid element when the size changes, which would drop a
//! listener attached to the old one.
//!
//! The crate runs its own frame loop instead of `draw_web`. Ratzilla 0.3.1's
//! DOM backend reports the window's size to Ratatui, not its grid's, so a
//! terminal smaller than the window draws past the grid. Here the viewport is
//! fixed to the grid the backend actually built.
//!
//! One crate serves both drawers and the IDE: the bottom drawer mounts a
//! single session, the right drawer and the terminal docked beside the IDE
//! mount with tabs, each tab its own agent thread.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    rc::Rc,
};

use keybinds::{Key, KeyInput, Mods};
use ratatui::{
    Frame, Terminal, TerminalOptions, Viewport,
    backend::Backend,
    buffer::Buffer,
    layout::{Constraint, Layout, Position, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Paragraph, Tabs, Widget, Wrap},
};
use ratzilla::{
    DomBackend,
    backend::cell_sized::CellSized,
    event::{KeyCode, KeyEvent},
    web_sys::{self, Event, KeyboardEvent},
};
use serde::Deserialize;
use serde_json::json;
use theorem_workbench_core::caret::escaped;
use theorem_workbench_panels::clip::finish_cut;
use theorem_workbench_text::field::{Field as TextField, FieldStyles, Keyed};
use theorem_workbench_text::visible::visible;
use tui_markdown::{Options, StyleSheet};
use wasm_bindgen::prelude::*;

mod blocks;
mod cabinet;
mod cabinet_panel;
pub mod preview;
mod theo;
mod workbench;

pub use cabinet::{CabinetHandle, mount_cabinet};
pub use workbench::{WorkbenchHandle, mount_workbench};

/// The terminal's colours. The page works them out from the workspace around
/// the terminal (src/components/terminal/terminal-theme.ts) and sets them with
/// `set_palette`; until then the terminal draws pi's slate.
///
/// The page sends the complete role contract (terminal-roles.ts): the legacy
/// keys through its one compatibility map, and the semantic roles beside
/// them. A role it leaves out keeps the slate's, so an older page still draws.
#[derive(Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Palette {
    #[serde(deserialize_with = "colour")]
    bg: Color,
    /// Tool rows: green belongs to a diff's added lines.
    #[serde(deserialize_with = "colour")]
    raised: Color,
    #[serde(deserialize_with = "colour")]
    line: Color,
    #[serde(deserialize_with = "colour")]
    ink: Color,
    #[serde(deserialize_with = "colour")]
    bright: Color,
    #[serde(deserialize_with = "colour")]
    muted: Color,
    /// The prompt's cursor while the terminal is not focused.
    #[serde(deserialize_with = "colour")]
    idle: Color,
    #[serde(deserialize_with = "colour")]
    sage: Color,
    #[serde(deserialize_with = "colour")]
    gold: Color,
    #[serde(deserialize_with = "colour")]
    error: Color,
    #[serde(deserialize_with = "colour")]
    removed_line: Color,
    #[serde(deserialize_with = "colour")]
    added_line: Color,
    #[serde(deserialize_with = "colour")]
    removed_words: Color,
    #[serde(deserialize_with = "colour")]
    added_words: Color,
    /// A comment's changed words: the code grey, lifted to read on either tint.
    #[serde(deserialize_with = "colour")]
    comment_on_words: Color,
    // Semantic roles (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §7). Headings are the
    // bright text in bold; the prompt, caret and progress take the accent;
    // amber is the warning family only.
    #[serde(deserialize_with = "colour")]
    heading: Color,
    #[serde(deserialize_with = "colour")]
    accent: Color,
    #[serde(deserialize_with = "colour")]
    focus: Color,
    /// The letters of the thing that is chosen or matched.
    #[serde(deserialize_with = "colour")]
    mark: Color,
    #[serde(deserialize_with = "colour")]
    selection: Color,
    #[serde(deserialize_with = "colour")]
    disabled: Color,
    #[serde(deserialize_with = "colour")]
    deep: Color,
    #[serde(deserialize_with = "colour")]
    warning: Color,
    #[serde(deserialize_with = "colour")]
    success: Color,
    #[serde(deserialize_with = "colour")]
    link: Color,
    #[serde(deserialize_with = "colour")]
    approval: Color,
    #[serde(deserialize_with = "colour")]
    syntax_keyword: Color,
    #[serde(deserialize_with = "colour")]
    syntax_string: Color,
    #[serde(deserialize_with = "colour")]
    syntax_number: Color,
    #[serde(deserialize_with = "colour")]
    syntax_function: Color,
    #[serde(deserialize_with = "colour")]
    syntax_variable: Color,
    #[serde(deserialize_with = "colour")]
    syntax_type: Color,
    #[serde(deserialize_with = "colour")]
    syntax_tag: Color,
    #[serde(deserialize_with = "colour")]
    syntax_comment: Color,
    // The roles the surface ladder adds (src/components/terminal/terminal-ladder.ts,
    // which the page sends by default). Each is optional and, left out, resolves
    // (through the accessor under `impl Palette`) to exactly what the thing drew
    // before the ladder, so a host that sends none of them still draws.
    /// The conversation's ground, a step below the panels'.
    #[serde(deserialize_with = "optional_colour")]
    canvas: Option<Color>,
    /// The band behind a selected row; none draws no band.
    #[serde(deserialize_with = "optional_colour")]
    selected_row: Option<Color>,
    /// A completed tool call's row ground.
    #[serde(deserialize_with = "optional_colour")]
    completed_row: Option<Color>,
    /// A running operation's block.
    #[serde(deserialize_with = "optional_colour")]
    running_row: Option<Color>,
    /// A tool call that waits on the person's decision.
    #[serde(deserialize_with = "optional_colour")]
    pending_row: Option<Color>,
    /// A tool call that failed.
    #[serde(deserialize_with = "optional_colour")]
    failed_row: Option<Color>,
    /// The name of a completed tool call.
    #[serde(deserialize_with = "optional_colour")]
    completed_ink: Option<Color>,
    /// Informational marks (the unread dot).
    #[serde(deserialize_with = "optional_colour")]
    info: Option<Color>,
    /// Low-value metadata: a time, a line number.
    #[serde(deserialize_with = "optional_colour")]
    text_disabled: Option<Color>,
    /// The mark in front of an added and a removed diff line.
    #[serde(deserialize_with = "optional_colour")]
    diff_added_mark: Option<Color>,
    #[serde(deserialize_with = "optional_colour")]
    diff_removed_mark: Option<Color>,
}

impl Palette {
    /// Where Theo's transcript and composer sit: the panels' own ground unless the page sends a canvas.
    fn canvas(&self) -> Color {
        self.canvas.unwrap_or(self.bg)
    }
    fn completed_row(&self) -> Color {
        self.completed_row.unwrap_or(self.raised)
    }
    fn running_row(&self) -> Color {
        self.running_row.unwrap_or(self.raised)
    }
    fn pending_row(&self) -> Color {
        self.pending_row.unwrap_or(self.raised)
    }
    fn failed_row(&self) -> Color {
        self.failed_row.unwrap_or(self.raised)
    }
    fn completed_ink(&self) -> Color {
        self.completed_ink.unwrap_or(self.bright)
    }
    fn text_disabled(&self) -> Color {
        self.text_disabled.unwrap_or(self.muted)
    }
    fn diff_added_mark(&self) -> Color {
        self.diff_added_mark.unwrap_or(self.syntax_tag)
    }
    fn diff_removed_mark(&self) -> Color {
        self.diff_removed_mark.unwrap_or(self.syntax_keyword)
    }
}

// pi's slate as it is drawn in GitHub Sharp, where every other palette's
// terminal is derived from (terminal-theme.ts keeps the same values, and
// terminal-palette.test.ts holds the two equal). On the slate:
// - pi's muted grey (#6c747c, the idle cursor) is lifted in OKLCH lightness
//   only, 0.555 to 0.675, to read at 4.5:1 on the slate and the raised slate;
// - a diff's rows are set in OKLCH rather than laid over it: GitHub Dark's
//   translucent diff colours, mixed over a blue slate, drift to plum and
//   teal. Each pair keeps the hue of GitHub Dark's diff red (#da3633, 26.8)
//   or green (#238636, 146.3) and shares one lightness and chroma, so neither
//   side reads stronger. Text contrast caps how light changed words can be,
//   so they stand apart from their row by chroma, with a quiet row: a row
//   has chroma 0.02, below GitHub's 0.03, because red and green sit across
//   the hue circle from the slate's blue; changed words have chroma 0.09, a
//   little above GitHub's 0.08; each is at the highest lightness where its
//   text keeps 4.5:1: every code colour on a row, every one but a comment's
//   on changed words;
// - a comment's changed words take its grey lifted in lightness, 0.662 to
//   0.714, to read at 4.5:1 on either word tint.
const SLATE: Palette = Palette {
    bg: Color::Rgb(0x20, 0x27, 0x33),
    raised: Color::Rgb(0x27, 0x30, 0x42),
    line: Color::Rgb(0x3a, 0x44, 0x58),
    ink: Color::Rgb(0xc8, 0xd0, 0xd8),
    bright: Color::Rgb(0xe4, 0xea, 0xee),
    muted: Color::Rgb(0x8f, 0x98, 0xa0),
    idle: Color::Rgb(0x6c, 0x74, 0x7c),
    sage: Color::Rgb(0x8a, 0xa8, 0xa0),
    gold: Color::Rgb(0xd6, 0xbc, 0x8a),
    error: Color::Rgb(0xe0, 0x8a, 0x8f),
    removed_line: Color::Rgb(0x36, 0x29, 0x27), // oklch(0.295 0.020 28.4)
    added_line: Color::Rgb(0x26, 0x2f, 0x26),   // oklch(0.293 0.020 145.0)
    removed_words: Color::Rgb(0x5e, 0x21, 0x1d), // oklch(0.339 0.090 26.7)
    added_words: Color::Rgb(0x0e, 0x43, 0x18),  // oklch(0.338 0.090 146.3)
    comment_on_words: Color::Rgb(0x9a, 0xa4, 0xae),
    // The roles terminal-roles.ts resolves on the slate itself.
    heading: Color::Rgb(0xe4, 0xea, 0xee),
    accent: Color::Rgb(0x8a, 0xa8, 0xa0),
    focus: Color::Rgb(0x8a, 0xa8, 0xa0),
    mark: Color::Rgb(0xe2, 0x81, 0x3f),
    selection: Color::Rgb(0x27, 0x30, 0x42),
    disabled: Color::Rgb(0x6c, 0x74, 0x7c),
    deep: Color::Rgb(0x12, 0x19, 0x24),
    warning: Color::Rgb(0xd6, 0xbc, 0x8a),
    success: Color::Rgb(0x7e, 0xe7, 0x87),
    link: Color::Rgb(0x58, 0xa6, 0xff),
    approval: Color::Rgb(0xd6, 0xbc, 0x8a),
    syntax_keyword: Color::Rgb(0xff, 0x7b, 0x72),
    syntax_string: Color::Rgb(0xa5, 0xd6, 0xff),
    syntax_number: Color::Rgb(0x79, 0xc0, 0xff),
    syntax_function: Color::Rgb(0xd2, 0xa8, 0xff),
    syntax_variable: Color::Rgb(0xff, 0xa6, 0x57),
    syntax_type: Color::Rgb(0xff, 0xa6, 0x57),
    syntax_tag: Color::Rgb(0x7e, 0xe7, 0x87),
    syntax_comment: Color::Rgb(0x8e, 0x98, 0xa2), // #8b949e, lifted to read on the raised slate
    canvas: None,
    selected_row: None,
    completed_row: None,
    running_row: None,
    pending_row: None,
    failed_row: None,
    completed_ink: None,
    info: None,
    text_disabled: None,
    diff_added_mark: None,
    diff_removed_mark: None,
};

impl Default for Palette {
    fn default() -> Self {
        SLATE
    }
}

thread_local! {
    /// One palette for the page: every terminal on it sits in the same workspace.
    static PALETTE: Cell<Palette> = const { Cell::new(SLATE) };
}

/// A palette colour from its `#rrggbb` string, by Ratatui's own parser.
fn colour<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Color, D::Error> {
    String::deserialize(deserializer)?
        .parse()
        .map_err(serde::de::Error::custom)
}

/// An optional palette colour: a `#rrggbb` string or nothing.
fn optional_colour<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Color>, D::Error> {
    Option::<String>::deserialize(deserializer)?
        .map(|text| text.parse().map_err(serde::de::Error::custom))
        .transpose()
}

/// The colours to draw in.
fn palette() -> Palette {
    PALETTE.get()
}

/// Sets every terminal's colours: JSON with terminal-theme.ts's
/// `TerminalTheme` keys, each a `#rrggbb` colour. Each terminal redraws in
/// them at its next frame.
#[wasm_bindgen]
pub fn set_palette(json: &str) -> Result<(), JsValue> {
    let palette =
        serde_json::from_str(json).map_err(|error| JsValue::from_str(&error.to_string()))?;
    PALETTE.set(palette);
    Ok(())
}

// Code colours are the palette's syntax roles: GitHub Dark's token colours
// (TanStack Highlight's github-dark), lifted where the terminal's surfaces
// need them to read (terminal-roles.ts).

/// Edit diffs show this many lines under their row until ctrl+o.
const DIFF_FOLD: usize = 12;

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PROMPT: &str = "❯ ";
/// Transcript text sits under the prompt's text, not under its glyph.
const INDENT: &str = "  ";
const NOTICE_MS: f64 = 4000.0;
/// Columns at the right of the header bar left clear for the page's close button.
const CLOSE_COLUMNS: u16 = 4;
/// Marks where the agent is writing while its run works.
const CARET: &str = "▍";
/// The hollow cursor's blink half-period; it holds solid this long after a key.
const BLINK_MS: f64 = 530.0;

/// Markdown in the terminal's palette instead of tui-markdown's ANSI defaults.
#[derive(Clone, Copy)]
struct Markdown;

impl StyleSheet for Markdown {
    fn heading(&self, level: u8) -> Style {
        match level {
            1 | 2 => Style::new().fg(palette().heading).bold(),
            _ => Style::new().fg(palette().heading),
        }
    }
    fn code(&self) -> Style {
        Style::new().fg(palette().sage).bg(palette().raised)
    }
    fn link(&self) -> Style {
        Style::new().fg(palette().link).underlined()
    }
    fn blockquote(&self) -> Style {
        Style::new().fg(palette().muted).italic()
    }
    fn heading_meta(&self) -> Style {
        Style::new().fg(palette().muted)
    }
    fn html(&self) -> Style {
        Style::new().fg(palette().muted)
    }
    fn table_header(&self) -> Style {
        Style::new().fg(palette().bright).bold()
    }
    fn table_border(&self) -> Style {
        Style::new().fg(palette().line)
    }
    fn list_marker(&self) -> Style {
        Style::new().fg(palette().muted)
    }
}

/// What React pushes in: the terminal thread's messages and run state.
#[derive(Deserialize, Default)]
#[serde(default)]
struct Snapshot {
    running: bool,
    project: String,
    error: Option<String>,
    /// The run's pending approval, answered with y or n.
    approval: Option<Approval>,
    /// What the run says it is doing, from its latest progress part.
    activity: Option<String>,
    messages: Vec<Message>,
    /// What the person sent while a run worked that the transcript does not
    /// show yet: still sending, queued, refused, or going as the next turn.
    outgoing: Vec<Sent>,
    /// What the next turn carries, added from the IDE, shown over the prompt.
    references: Vec<String>,
    /// Where this reply's thread stands among its branches, when it has more than one.
    branches: Option<Branches>,
    /// The owner's clock when it made the snapshot, in milliseconds since the
    /// epoch: what a running call's time is counted to. The drawer has no clock of its own for it.
    #[serde(default, rename = "nowMs")]
    now_ms: Option<f64>,
}

impl Snapshot {
    /// Every word of the snapshot is the run's or the person's files', never
    /// typed here: a control or hidden character in a message, a tool's name
    /// or arguments, an approval or a reason is spelled out where it would
    /// reorder or hide what is shown, so a tool argument cannot dress up an
    /// approval prompt. Newline and tab keep their shape. What the run
    /// identifies things by (ids, the path a tool row opens) is left as it is.
    fn spell_out(&mut self) {
        fn spell(text: &mut String) {
            *text = escaped(&text.replace("\r\n", "\n"));
        }
        fn spell_tokens(lines: &mut [Vec<Token>]) {
            lines.iter_mut().flatten().for_each(|t| spell(&mut t.t));
        }
        fn spell_diff(diff: &mut [DiffLine]) {
            diff.iter_mut()
                .for_each(|d| d.t.iter_mut().for_each(|t| spell(&mut t.t)));
        }
        fn spell_sent(sent: &mut Sent) {
            spell(&mut sent.text);
            sent.reason.iter_mut().for_each(spell);
        }
        self.error.iter_mut().for_each(spell);
        self.activity.iter_mut().for_each(spell);
        spell(&mut self.project);
        self.references.iter_mut().for_each(spell);
        if let Some(approval) = &mut self.approval {
            spell(&mut approval.tool);
            spell(&mut approval.summary);
        }
        self.outgoing.iter_mut().for_each(spell_sent);
        for message in &mut self.messages {
            message.attachments.iter_mut().for_each(spell);
            for part in &mut message.parts {
                match part {
                    Part::Text { text } | Part::Reasoning { text, .. } => spell(text),
                    Part::Tool {
                        name,
                        summary,
                        output,
                        ..
                    } => {
                        spell(name);
                        spell(summary);
                        if let Some(output) = output {
                            spell_tokens(&mut output.lines);
                            spell_diff(&mut output.diff);
                        }
                    }
                    Part::Program { lines, .. } => spell_tokens(lines),
                    Part::Input(sent) => spell_sent(sent),
                    Part::Receipt { text, .. } => spell(text),
                    Part::Code { lang, lines, diff } => {
                        spell(lang);
                        spell_tokens(lines);
                        spell_diff(diff);
                    }
                    Part::Other => {}
                }
            }
        }
    }
}

/// The selected branch's place among the thread's branches, the root first, both counted from 1.
#[derive(Deserialize, Clone, Copy)]
struct Branches {
    position: usize,
    total: usize,
}

/// Words the person sent to a working run, and how far they got.
#[derive(Deserialize)]
struct Sent {
    text: String,
    /// sending, queued, delivered, not_delivered, next, resent or failed.
    #[serde(default)]
    status: String,
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Deserialize)]
struct Approval {
    tool: String,
    summary: String,
}

#[derive(Deserialize)]
struct Message {
    /// The message's own id, which keeps what the person opened in it; the drawer's pages send none.
    #[serde(default)]
    id: Option<String>,
    role: String,
    parts: Vec<Part>,
    /// The files a user turn carried, by name. The workbench's conversation
    /// panel fills it; the drawer's pages do not send it.
    #[serde(default)]
    attachments: Vec<String>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Part {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
        /// When the thinking began and ended, by the owner's clock, when it says.
        #[serde(default, rename = "startedAtMs")]
        started_at_ms: Option<f64>,
        #[serde(default, rename = "endedAtMs")]
        ended_at_ms: Option<f64>,
    },
    Tool {
        name: String,
        #[serde(default)]
        summary: String,
        /// running, complete, error or approval.
        #[serde(default)]
        status: String,
        /// What it returned, shown under the row with ctrl+o.
        #[serde(default)]
        output: Option<Output>,
        /// The file it worked on, which a click on the row opens.
        #[serde(default)]
        open: Option<Open>,
        /// The tool call's own id, which lets the person show or hide this
        /// one result. The drawer's pages send none and keep ctrl+o only.
        #[serde(default)]
        id: Option<String>,
        /// When the call began and ended, by the owner's clock, when it says.
        #[serde(default, rename = "startedAtMs")]
        started_at_ms: Option<f64>,
        #[serde(default, rename = "endedAtMs")]
        ended_at_ms: Option<f64>,
    },
    /// The program the native agent writes and runs, streaming as it types.
    Program {
        lines: Vec<Vec<Token>>,
        #[serde(default)]
        streaming: bool,
    },
    /// Sent while the run worked, drawn where the run took it in.
    Input(Sent),
    /// How an approval the run asked for was answered, drawn where it was asked: what was
    /// asked and the answer (`approved`, `declined`, `failed` or `unanswered`).
    Receipt {
        text: String,
        #[serde(default)]
        outcome: String,
        /// The approval it answers, so the overlay can name the row it is drawn on.
        #[serde(default)]
        approval: String,
    },
    /// A fenced block from an answer, highlighted by the page.
    Code {
        #[serde(default)]
        lang: String,
        #[serde(default)]
        lines: Vec<Vec<Token>>,
        /// A fenced diff, drawn in place of `lines`.
        #[serde(default)]
        diff: Vec<DiffLine>,
    },
    #[serde(other)]
    Other,
}

/// A tool's result, highlighted, its first lines and a count of the rest.
/// An edit's result is a diff, drawn in place of `lines`.
#[derive(Deserialize)]
struct Output {
    #[serde(default)]
    lines: Vec<Vec<Token>>,
    #[serde(default)]
    diff: Vec<DiffLine>,
    #[serde(default)]
    more: usize,
}

/// A diff's line: `file`, `hunk`, or a code line kept (`ctx`), removed
/// (`del`) or added (`add`), its code without the marker.
#[derive(Deserialize)]
struct DiffLine {
    k: String,
    t: Vec<Token>,
}

/// A file and the lines a tool touched in it, one-based, both ends included.
#[derive(Deserialize, Clone, Debug)]
struct Open {
    path: String,
    #[serde(default)]
    start: Option<u32>,
    #[serde(default)]
    end: Option<u32>,
}

/// A run of code text and its highlight class (TanStack Highlight's names).
/// In a diff, `e` marks words the line changed.
#[derive(Deserialize)]
struct Token {
    t: String,
    #[serde(default)]
    c: Option<String>,
    #[serde(default)]
    e: bool,
}

/// What the person asked for, handed back to React as JSON. Each names the
/// tab it came from; a single-session terminal has one tab.
enum Action {
    Submit(String),
    /// Words for the run that is working; they never stop it.
    Input(String),
    Cancel,
    Close,
    New,
    Approve(bool),
    NewTab,
    CloseTab,
    SelectTab,
    /// Open a file a tool worked on, in the IDE.
    Open(Open),
    /// Drop the last reference the next turn carries.
    Unreference,
    /// Put the prompt's selection on the clipboard; a cut then removes it. The handle answers
    /// this itself and React never hears it: the root prompt has no effect system, so the
    /// browser's clipboard is the route.
    Clipboard {
        text: String,
        cut: bool,
    },
}

impl Action {
    fn to_json(&self, tab: &str) -> String {
        match self {
            Action::Submit(text) => json!({ "type": "submit", "tab": tab, "text": text }),
            Action::Input(text) => json!({ "type": "input", "tab": tab, "text": text }),
            Action::Cancel => json!({ "type": "cancel", "tab": tab }),
            Action::Close => json!({ "type": "close", "tab": tab }),
            Action::New => json!({ "type": "new", "tab": tab }),
            Action::Approve(allow) => json!({ "type": "approve", "tab": tab, "allow": allow }),
            Action::NewTab => json!({ "type": "newTab", "tab": tab }),
            Action::CloseTab => json!({ "type": "closeTab", "tab": tab }),
            Action::SelectTab => json!({ "type": "selectTab", "tab": tab }),
            Action::Open(Open { path, start, end }) => {
                json!({ "type": "open", "tab": tab, "path": path, "start": start, "end": end })
            }
            Action::Unreference => json!({ "type": "unreference", "tab": tab }),
            Action::Clipboard { text, cut } => {
                json!({ "type": "clipboard", "tab": tab, "text": text, "cut": cut })
            }
        }
        .to_string()
    }
}

/// The tab list React keeps: ids in order, titles, and the one showing.
#[derive(Deserialize)]
struct TabList {
    tabs: Vec<TabEntry>,
    active: String,
}

#[derive(Deserialize)]
struct TabEntry {
    id: String,
    title: String,
}

/// What a click on the tab bar lands on.
#[derive(Clone, Copy)]
enum Hit {
    Select(usize),
    Close(usize),
    New,
}

fn own(text: Text<'_>) -> Vec<Line<'static>> {
    text.lines
        .into_iter()
        .map(|line| {
            Line::from(
                line.spans
                    .into_iter()
                    .map(|span| Span::styled(span.content.into_owned(), span.style))
                    .collect::<Vec<_>>(),
            )
            .style(line.style)
        })
        .collect()
}

fn indented(mut line: Line<'static>) -> Line<'static> {
    line.spans.insert(0, Span::raw(INDENT));
    line
}

/// Transcript lines carry their indent, so blank means nothing but spaces.
fn blank(line: &Line) -> bool {
    line.spans.iter().all(|span| span.content.trim().is_empty())
}

/// Ends the transcript so far with one blank line, unless it already does.
fn separate(lines: &mut Vec<Line<'static>>) {
    if lines.last().is_some_and(|line| !blank(line)) {
        lines.push(Line::default());
    }
}

/// A highlight class in GitHub Dark, as TanStack's github-dark theme colours it.
fn token_style(class: Option<&str>) -> Style {
    let style = Style::new();
    match class {
        Some("keyword" | "deleted") => style.fg(palette().syntax_keyword),
        Some("function" | "command" | "operator") => style.fg(palette().syntax_function),
        Some("number" | "literal" | "attr" | "property") => style.fg(palette().syntax_number),
        Some("heading") => style.fg(palette().syntax_number).bold(),
        Some("string") => style.fg(palette().syntax_string),
        Some("type" | "variable" | "code-inline") => style.fg(palette().syntax_variable),
        Some("tag" | "selector" | "inserted") => style.fg(palette().syntax_tag),
        Some("comment" | "meta") => style.fg(palette().syntax_comment),
        Some("link") => style.fg(palette().link),
        _ => style.fg(palette().ink),
    }
}

/// Code tokens as one line in the terminal's colours.
fn token_line(tokens: &[Token]) -> Vec<Span<'static>> {
    tokens
        .iter()
        .map(|token| {
            // A tab would leave the cell grid; it takes four columns.
            Span::styled(
                token.t.replace('\t', "    "),
                token_style(token.c.as_deref()),
            )
        })
        .collect()
}

/// A tool's output under its row, aligned with the tool's name: its first
/// `shown` lines, then a count of the rest. A line carries the background
/// its row is painted across.
fn output_lines(output: &Output, shown: usize) -> Vec<(Line<'static>, Option<Color>)> {
    let lead = format!("{INDENT}  ");
    let (mut lines, cut) = if output.diff.is_empty() {
        let lines = output.lines.iter().take(shown).map(|tokens| {
            let mut spans = vec![Span::raw(lead.clone())];
            spans.extend(token_line(tokens));
            (Line::from(spans), None)
        });
        (
            lines.collect::<Vec<_>>(),
            output.lines.len().saturating_sub(shown),
        )
    } else {
        let cut = output.diff.len().saturating_sub(shown);
        (
            diff_lines(&output.diff[..output.diff.len() - cut], &lead),
            cut,
        )
    };
    let more = output.more + cut;
    if more > 0 {
        lines.push((
            Line::styled(
                format!(
                    "{lead}… {more} more line{}",
                    if more == 1 { "" } else { "s" }
                ),
                Style::new().fg(palette().muted),
            ),
            None,
        ));
    }
    lines
}

/// Columns a line's indent spans, a tab counting four.
fn indent_of(text: &str) -> usize {
    text.chars().take_while(|c| *c == ' ').count()
}

/// A diff the way Delta draws one: each code line in its language's
/// colours behind a `-`, `+` or blank marker, with an indent guide at each
/// level, its row tinted removed or added and the words it changed
/// brighter. Hunk headers and file names stay quiet.
fn diff_lines(diff: &[DiffLine], lead: &str) -> Vec<(Line<'static>, Option<Color>)> {
    let code = |line: &DiffLine| {
        line.t
            .iter()
            .map(|token| token.t.replace('\t', "    "))
            .collect::<String>()
    };
    // Indent guides step by the diff's own smallest indent.
    let unit = diff
        .iter()
        .filter(|line| matches!(line.k.as_str(), "ctx" | "del" | "add"))
        .map(&code)
        .filter(|text| !text.trim().is_empty())
        .map(|text| indent_of(&text))
        .filter(|indent| *indent > 0)
        .min()
        .unwrap_or(4)
        .clamp(2, 8);
    diff.iter()
        .map(|line| {
            let (marker, mark, fill, words) = match line.k.as_str() {
                "del" => (
                    "-",
                    palette().diff_removed_mark(),
                    Some(palette().removed_line),
                    palette().removed_words,
                ),
                "add" => (
                    "+",
                    palette().diff_added_mark(),
                    Some(palette().added_line),
                    palette().added_words,
                ),
                "ctx" => (" ", palette().muted, None, palette().canvas()),
                // A file it changes, then each hunk's header.
                quiet => {
                    let style = if quiet == "file" {
                        Style::new().fg(palette().ink).bold()
                    } else {
                        Style::new().fg(palette().syntax_comment)
                    };
                    return (Line::styled(format!("{lead}{}", code(line)), style), None);
                }
            };
            let text = code(line);
            let indent = if text.trim().is_empty() {
                0
            } else {
                indent_of(&text)
            };
            let mut spans = vec![
                Span::raw(lead.to_owned()),
                Span::styled(format!("{marker} "), Style::new().fg(mark)),
            ];
            let mut guides = String::new();
            for column in 0..indent {
                guides.push(if column % unit == 0 { '│' } else { ' ' });
            }
            spans.push(Span::styled(guides, Style::new().fg(palette().line)));
            // The indent is drawn as guides; the code follows from there.
            let mut skip = indent;
            for token in &line.t {
                let piece = token.t.replace('\t', "    ");
                let dropped = piece.chars().take(skip).count();
                skip -= dropped;
                let rest: String = piece.chars().skip(dropped).collect();
                if rest.is_empty() {
                    continue;
                }
                let style = token_style(token.c.as_deref());
                let comment = Some(palette().syntax_comment);
                spans.push(Span::styled(
                    rest,
                    match (token.e, style.fg) {
                        (true, fg) if fg == comment => {
                            style.fg(palette().comment_on_words).bg(words)
                        }
                        (true, _) => style.bg(words),
                        (false, _) => style,
                    },
                ));
            }
            let row = Line::from(spans);
            (
                match fill {
                    Some(fill) => row.style(Style::new().bg(fill)),
                    None => row,
                },
                fill,
            )
        })
        .collect()
}

/// What a transcript build makes: its lines, the rows painted across, and what a click finds.
#[derive(Default)]
struct Built {
    lines: Vec<Line<'static>>,
    fills: Vec<(usize, Color)>,
    toggles: Vec<(usize, String)>,
    links: Vec<(usize, Open)>,
    blocks: Vec<blocks::BlockRow>,
    receipts: Vec<(usize, String)>,
}

impl Built {
    /// Lines whose rows carry a background, noting which.
    fn filled(&mut self, rows: Vec<(Line<'static>, Option<Color>)>) {
        for (line, fill) in rows {
            if let Some(fill) = fill {
                self.fills.push((self.lines.len(), fill));
            }
            self.lines.push(line);
        }
    }

    /// A code block with no fences, on the raised surface.
    fn code(&mut self, code: &[Vec<Token>]) {
        let raised = palette().raised;
        self.filled(
            blocks::code_block(code)
                .into_iter()
                .map(|line| (line, Some(raised)))
                .collect(),
        );
    }
}

/// Thinking, or a tool call that has ended: what a finished turn folds into its summary.
fn is_activity(part: &Part) -> bool {
    match part {
        Part::Reasoning { .. } => true,
        Part::Tool { status, .. } => {
            matches!(status.as_str(), "complete" | "error" | "interrupted") && !is_diff(part)
        }
        _ => false,
    }
}

/// A tool call that wrote code: one whose output is a diff.
fn is_diff(part: &Part) -> bool {
    matches!(part, Part::Tool { output: Some(output), .. } if !output.diff.is_empty())
}

#[cfg(target_arch = "wasm32")]
fn now() -> f64 {
    js_sys::Date::now()
}

/// The host's clock, so the transcript's spinner and notices run in tests.
#[cfg(not(target_arch = "wasm32"))]
fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

/// The spinner's frame for now. The index is taken in f64: the clock over
/// 80 ms is past `u32::MAX`, so a `usize` cast on wasm32 saturates and the
/// spinner would stop on one frame.
fn spinner() -> &'static str {
    SPINNER[(now() / 80.0 % SPINNER.len() as f64) as usize]
}

/// One tab: an agent thread's transcript and its own prompt line.
struct Session {
    id: String,
    title: String,
    /// Whether the terminal shows tabs, for the help list.
    tabbed: bool,
    snapshot: Snapshot,
    input: TextField,
    /// Submitted prompts, oldest first, walked with Up and Down.
    history: Vec<String>,
    history_at: Option<usize>,
    /// Lines scrolled up from the bottom; zero follows new output.
    scroll_back: usize,
    /// Body height at the last draw, for paging.
    page: usize,
    help: bool,
    /// Whether tool output and finished programs show (ctrl+o).
    expanded: bool,
    /// Whether the transcript has output for ctrl+o to show.
    has_output: bool,
    notice: Option<(String, f64)>,
    /// Whether the panel's own composer says what Enter and Esc do, so the
    /// status row leaves that hint out. The drawer's prompt is the session's
    /// own and keeps it.
    hint_in_footer: bool,
    /// Whether the panel draws the waiting approval in a region of its own, so the status
    /// row leaves it out.
    approval_elsewhere: bool,
    /// Transcript lines, rebuilt when the snapshot, the width or the palette changes.
    lines: Vec<Line<'static>>,
    /// Each line's first row once wrapped, then the total, for clicks.
    rows: Vec<usize>,
    /// The tool rows a click opens, by line.
    links: Vec<(usize, Open)>,
    /// Tool results the person showed one at a time, by tool id.
    disclosed: BTreeSet<String>,
    /// The tool rows a click shows or hides, by line.
    toggles: Vec<(usize, String)>,
    /// Each message's first line, for the semantic tree.
    starts: Vec<usize>,
    /// A message to scroll to at the next draw, by its index: a saved view.
    pin: Option<usize>,
    /// Lines whose background spans the whole row, as a diff's rows do.
    fills: Vec<(usize, Color)>,
    /// The body's area and its first shown row at the last draw.
    body: Rect,
    top: usize,
    built_for: Option<(u16, Palette)>,
    /// How much of the agent's activity shows.
    level: blocks::Activity,
    /// The transcript's blocks by line, at the last build.
    blocks: Vec<blocks::BlockRow>,
    /// The approval receipts by line and the approval each answers, at the last build.
    receipts: Vec<(usize, String)>,
    /// The block the keys are on, by key, while they walk the transcript.
    cursor: Option<String>,
    /// Scroll the cursor's block into view at the next draw.
    reveal: bool,
    /// A block just opened or closed, by key, and the body row its header was on: the next
    /// draw keeps it there, so what it opened grows below it and not under the pointer.
    anchor: Option<(String, usize)>,
    /// Whether the status row names the activity level, for a click to change it.
    activity_control: bool,
    /// Where the status row named the level at the last draw.
    level_area: Rect,
}

impl Session {
    fn new(id: String, title: String, tabbed: bool) -> Self {
        Self {
            id,
            title,
            tabbed,
            snapshot: Snapshot::default(),
            input: TextField::default(),
            history: Vec::new(),
            history_at: None,
            scroll_back: 0,
            page: 10,
            help: false,
            expanded: false,
            has_output: false,
            notice: None,
            hint_in_footer: false,
            approval_elsewhere: false,
            lines: Vec::new(),
            rows: Vec::new(),
            links: Vec::new(),
            disclosed: BTreeSet::new(),
            toggles: Vec::new(),
            starts: Vec::new(),
            pin: None,
            fills: Vec::new(),
            body: Rect::default(),
            top: 0,
            built_for: None,
            level: blocks::Activity::default(),
            blocks: Vec::new(),
            receipts: Vec::new(),
            cursor: None,
            reveal: false,
            anchor: None,
            activity_control: false,
            level_area: Rect::default(),
        }
    }

    fn set_state(&mut self, json: &str) -> Result<(), serde_json::Error> {
        self.set_snapshot(serde_json::from_str(json)?);
        Ok(())
    }

    /// Take a snapshot already read, as the workbench's conversation panel does.
    fn set_snapshot(&mut self, mut snapshot: Snapshot) {
        snapshot.spell_out();
        self.snapshot = snapshot;
        self.built_for = None;
    }

    fn notify(&mut self, text: impl Into<String>) {
        self.notice = Some((escaped(&text.into()), now() + NOTICE_MS));
    }

    /// Whether a block the person can open is open: the level's default, unless they flipped it.
    fn is_open(&self, key: &str, default: bool) -> bool {
        default != self.disclosed.contains(key)
    }

    /// Set how much of the agent's activity shows; what the person opened or closed under the
    /// old level is let go, so the new one is what is seen.
    fn set_level(&mut self, level: blocks::Activity) {
        if self.level != level {
            self.level = level;
            self.disclosed.clear();
            self.built_for = None;
        }
    }

    /// One piece of activity as its header: thinking, or a finished tool call. Opened, its
    /// prose or its output follows.
    fn activity(&self, part: &Part, at: (usize, &str, usize), width: u16, out: &mut Built) {
        let (message, key_of_message, place) = at;
        let all = self.level == blocks::Activity::All;
        match part {
            Part::Reasoning {
                text,
                started_at_ms,
                ended_at_ms,
            } => {
                let key = format!("think:{key_of_message}:{place}");
                let open = self.is_open(&key, all);
                let time = blocks::took(*started_at_ms, *ended_at_ms);
                out.toggles.push((out.lines.len(), key.clone()));
                out.blocks.push(blocks::BlockRow {
                    line: out.lines.len(),
                    key,
                    kind: blocks::BlockKind::Thinking,
                    name: match &time {
                        Some(time) => format!("Thinking, {time}"),
                        None => "Thinking".to_owned(),
                    },
                    expanded: Some(open),
                    open: None,
                    path_cols: None,
                    message,
                    counts: None,
                    holds: None,
                });
                out.lines
                    .push(blocks::quiet_header("Thinking", time.as_deref(), open));
                if open {
                    out.lines.extend(blocks::thought_lines(text));
                }
            }
            Part::Tool {
                name,
                summary,
                status,
                output,
                open,
                id,
                started_at_ms,
                ended_at_ms,
            } => {
                if let Some(open) = open {
                    out.links.push((out.lines.len(), open.clone()));
                }
                let toggled = id.as_ref().filter(|_| output.is_some());
                let shown = match toggled {
                    Some(id) => self.is_open(id, all || self.expanded),
                    None => all || self.expanded,
                };
                if let Some(id) = toggled {
                    out.toggles.push((out.lines.len(), id.clone()));
                }
                let time = blocks::took(*started_at_ms, *ended_at_ms);
                out.blocks.push(blocks::BlockRow {
                    line: out.lines.len(),
                    key: id
                        .clone()
                        .unwrap_or_else(|| format!("{key_of_message}:{place}")),
                    kind: blocks::BlockKind::Tool,
                    name: format!(
                        "{name} {}{}",
                        match status.as_str() {
                            "complete" => "finished",
                            "error" => "failed",
                            "interrupted" => "was interrupted",
                            "approval" => "waits on your approval",
                            _ => "is running",
                        },
                        time.as_ref()
                            .map(|t| format!(" in {t}"))
                            .unwrap_or_default()
                    ),
                    expanded: toggled.map(|_| shown),
                    open: open.clone(),
                    path_cols: None,
                    message,
                    counts: None,
                    holds: None,
                });
                let extra = time
                    .map(|t| {
                        vec![Span::styled(
                            format!("  {t}"),
                            Style::new().fg(palette().text_disabled()),
                        )]
                    })
                    .unwrap_or_default();
                out.lines
                    .push(tool_row_extra(name, summary, status, open.is_some(), width, extra).0);
                if let Some(output) = output.as_ref().filter(|_| shown) {
                    out.filled(output_lines(output, usize::MAX));
                }
            }
            _ => {}
        }
    }

    /// Code the agent writes: its header (what wrote it, the file, the lines added and
    /// removed) and, open, the diff. A write still streaming shows its newest lines.
    fn diff_block(&self, part: &Part, at: (usize, &str, usize), width: u16, out: &mut Built) {
        let Part::Tool {
            name,
            summary,
            status,
            output: Some(output),
            open,
            id,
            ..
        } = part
        else {
            return;
        };
        let (message, key_of_message, place) = at;
        let key = format!(
            "diff:{}",
            id.clone()
                .unwrap_or_else(|| format!("{key_of_message}:{place}"))
        );
        let shown = self.is_open(&key, self.level != blocks::Activity::Summary);
        let (added, removed) = blocks::counts(&output.diff);
        let path = open.as_ref().map_or(summary.as_str(), |o| o.path.as_str());
        let (header, cols) = tool_row_extra(
            name,
            path,
            status,
            open.is_some(),
            width,
            blocks::diff_extra(added, removed, shown),
        );
        out.toggles.push((out.lines.len(), key.clone()));
        out.blocks.push(blocks::BlockRow {
            line: out.lines.len(),
            key,
            kind: blocks::BlockKind::Diff,
            name: format!("{name} {path}"),
            expanded: Some(shown),
            open: open.clone(),
            path_cols: open.as_ref().map(|_| cols),
            message,
            counts: Some((added, removed)),
            holds: None,
        });
        out.lines.push(header);
        if !shown {
            return;
        }
        let lead = format!("{INDENT}  ");
        let every = self.level == blocks::Activity::All || self.expanded;
        let total = output.diff.len();
        let note = |count: usize, what: &str| {
            (
                Line::styled(
                    format!(
                        "{lead}… {count} {what} line{}",
                        if count == 1 { "" } else { "s" }
                    ),
                    Style::new().fg(palette().muted),
                ),
                None,
            )
        };
        if every || total <= DIFF_FOLD {
            out.filled(diff_lines(&output.diff, &lead));
            if output.more > 0 {
                out.filled(vec![note(output.more, "more")]);
            }
        } else if status == "running" {
            // A write still streaming: its newest lines, under how many came before.
            let cut = total - DIFF_FOLD;
            out.filled(vec![note(cut, "earlier")]);
            out.filled(diff_lines(&output.diff[cut..], &lead));
        } else {
            out.filled(diff_lines(&output.diff[..DIFF_FOLD], &lead));
            out.filled(vec![note(total - DIFF_FOLD + output.more, "more")]);
        }
    }

    fn build(&mut self, width: u16) {
        let mut out = Built::default();
        let options = Options::new(Markdown).table_width(width.saturating_sub(INDENT.len() as u16));

        let last_message = self.snapshot.messages.len().saturating_sub(1);
        let mut caret = None;
        let mut starts = Vec::new();
        self.has_output = self
            .snapshot
            .messages
            .iter()
            .flat_map(|m| &m.parts)
            .any(|part| {
                matches!(
                    part,
                    Part::Tool {
                        output: Some(_),
                        ..
                    } | Part::Program {
                        streaming: false,
                        ..
                    }
                )
            });
        let p = palette();
        // The person's own words sit on a ground of their own: the panel's, a step above the
        // canvas the conversation is on, or the raised surface where the two are one.
        let own_ground = if p.canvas() != p.bg { p.bg } else { p.raised };
        for (index, message) in self.snapshot.messages.iter().enumerate() {
            starts.push(out.lines.len());
            if message.role == "user" {
                let text: String = message
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        Part::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let mut rows = Vec::new();
                for (index, row) in text.lines().enumerate() {
                    let lead = if index == 0 {
                        Span::styled(PROMPT, Style::new().fg(p.accent).bold())
                    } else {
                        Span::raw(INDENT)
                    };
                    rows.push((
                        Line::from(vec![
                            lead,
                            Span::styled(row.to_owned(), Style::new().fg(p.bright)),
                        ]),
                        Some(own_ground),
                    ));
                }
                for name in &message.attachments {
                    rows.push((
                        Line::from(vec![
                            Span::raw(INDENT),
                            Span::styled(format!("@{name}"), Style::new().fg(p.link)),
                        ]),
                        Some(own_ground),
                    ));
                }
                out.filled(rows);
                out.lines.push(Line::default());
                continue;
            }
            let key_of_message = message.id.clone().unwrap_or_else(|| index.to_string());
            let parts = &message.parts;
            let writing = self.snapshot.running && index == last_message;
            // A finished turn's activity folds to its summary at the headers level; every
            // turn's does at the summary level; nothing folds when everything shows.
            let fold = match self.level {
                blocks::Activity::All => false,
                blocks::Activity::Headers => !writing,
                blocks::Activity::Summary => true,
            };
            // A code block keeps a blank line from what comes before and after it.
            let mut after_code = false;
            let mut at = 0;
            while at < parts.len() {
                if fold && is_activity(&parts[at]) {
                    let run = parts[at..].iter().take_while(|p| is_activity(p)).count();
                    let group: Vec<&Part> = parts[at..at + run].iter().collect();
                    if after_code {
                        separate(&mut out.lines);
                        after_code = false;
                    }
                    let key = format!("sum:{key_of_message}:{at}");
                    let shown = self.disclosed.contains(&key);
                    let words = blocks::activity_words(&group);
                    let holds = group
                        .iter()
                        .filter_map(|part| match part {
                            Part::Reasoning { .. } => Some("Thinking".to_owned()),
                            Part::Tool {
                                name,
                                summary,
                                status,
                                ..
                            } => Some(format!("{name} {summary}: {status}")),
                            _ => None,
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    out.toggles.push((out.lines.len(), key.clone()));
                    out.blocks.push(blocks::BlockRow {
                        line: out.lines.len(),
                        key,
                        kind: blocks::BlockKind::Summary,
                        name: words.clone(),
                        expanded: Some(shown),
                        open: None,
                        path_cols: None,
                        message: index,
                        counts: None,
                        holds: Some(holds),
                    });
                    out.lines.push(blocks::quiet_header(&words, None, shown));
                    if shown {
                        for (offset, part) in group.into_iter().enumerate() {
                            self.activity(
                                part,
                                (index, &key_of_message, at + offset),
                                width,
                                &mut out,
                            );
                        }
                    }
                    at += run;
                    continue;
                }
                let part = &parts[at];
                let last_part = at + 1 == parts.len();
                // A finished program folds to a row unless shown; the one being written shows.
                let open_program = matches!(part, Part::Program { streaming, .. }
                    if *streaming || self.expanded || (writing && last_part));
                let running = matches!(part, Part::Tool { status, .. } if status == "running")
                    && !is_diff(part);
                let is_code = matches!(part, Part::Code { .. })
                    || open_program
                    || is_diff(part)
                    || running
                    || matches!(part, Part::Text { text } if text.contains("```") || text.contains("~~~"));
                if is_code || after_code {
                    separate(&mut out.lines);
                }
                after_code = is_code;
                let start = out.lines.len();
                let place = (index, key_of_message.as_str(), at);
                match part {
                    Part::Text { text } => {
                        for piece in blocks::pieces(text) {
                            match piece {
                                blocks::Piece::Prose(prose) => {
                                    let rendered =
                                        tui_markdown::from_str_with_options(&prose, &options);
                                    out.lines.extend(own(rendered).into_iter().map(indented));
                                }
                                blocks::Piece::Code(code) => {
                                    separate(&mut out.lines);
                                    out.code(&blocks::plain_tokens(&code));
                                    out.lines.push(Line::default());
                                }
                            }
                        }
                        while out.lines.len() > start && blank(&out.lines[out.lines.len() - 1]) {
                            out.lines.pop();
                        }
                    }
                    Part::Reasoning { .. } => self.activity(part, place, width, &mut out),
                    Part::Tool { .. } if is_diff(part) => {
                        self.diff_block(part, place, width, &mut out)
                    }
                    Part::Tool {
                        name,
                        summary,
                        output,
                        id,
                        started_at_ms,
                        ..
                    } if running => {
                        let elapsed = started_at_ms
                            .zip(self.snapshot.now_ms)
                            .map(|(from, to)| blocks::duration(to - from));
                        let key = format!(
                            "run:{}",
                            id.clone()
                                .unwrap_or_else(|| format!("{key_of_message}:{at}"))
                        );
                        out.blocks.push(blocks::BlockRow {
                            line: out.lines.len(),
                            key,
                            kind: blocks::BlockKind::Running,
                            name: format!(
                                "{name} is running: {summary}{}",
                                elapsed
                                    .as_ref()
                                    .map(|t| format!(", {t}"))
                                    .unwrap_or_default()
                            ),
                            expanded: None,
                            open: None,
                            path_cols: None,
                            message: index,
                            counts: None,
                            holds: None,
                        });
                        let tail = output.as_ref().map_or(&[][..], |o| o.lines.as_slice());
                        out.lines.extend(blocks::running_block(
                            name,
                            summary,
                            tail,
                            elapsed.as_deref(),
                            width,
                        ));
                    }
                    // A call that waits on the person is never folded away.
                    Part::Tool { .. } => self.activity(part, place, width, &mut out),
                    Part::Program { lines: code, .. } => {
                        if open_program {
                            out.code(code);
                        } else {
                            let count = code.len();
                            let summary =
                                format!("{count} line{}", if count == 1 { "" } else { "s" });
                            out.lines
                                .push(tool_row("program", &summary, "complete", false, width));
                        }
                    }
                    Part::Input(sent) => {
                        out.lines.extend(sent_lines(sent));
                        out.lines.push(Line::default());
                    }
                    Part::Receipt {
                        text,
                        outcome,
                        approval,
                    } => {
                        out.receipts.push((out.lines.len(), approval.clone()));
                        out.lines.push(receipt_line(text, outcome));
                    }
                    Part::Code { diff, .. } if !diff.is_empty() => {
                        out.filled(diff_lines(diff, INDENT));
                    }
                    Part::Code { lines: code, .. } => out.code(code),
                    Part::Other => {}
                }
                if writing && last_part {
                    caret = match part {
                        Part::Text { .. } => (start..out.lines.len())
                            .rev()
                            .find(|&row| !blank(&out.lines[row])),
                        Part::Code { .. } => out.lines.len().checked_sub(1),
                        Part::Program { .. } if open_program => out.lines.len().checked_sub(1),
                        _ => None,
                    };
                }
                at += 1;
            }
            out.lines.push(Line::default());
        }

        let Built {
            mut lines,
            fills,
            toggles,
            links,
            blocks,
            receipts,
        } = out;
        if let Some(row) = caret {
            lines[row]
                .spans
                .push(Span::styled(CARET, Style::new().fg(palette().accent)));
        }

        for sent in &self.snapshot.outgoing {
            lines.extend(sent_lines(sent));
            lines.push(Line::default());
        }

        if let Some(error) = &self.snapshot.error {
            lines.push(indented(Line::styled(
                format!("✗ {error}"),
                Style::new().fg(palette().error),
            )));
            lines.push(Line::default());
        }

        if self.help {
            let mut commands = vec![
                ("enter", "run it; while it works, send it along"),
                ("/new", "start a fresh thread here"),
                ("/help", "show or hide this list"),
                ("ctrl+c", "stop the run, or clear the prompt"),
                ("esc", "close the drawer"),
                ("↑ ↓", "walk earlier prompts"),
                ("pgup pgdn", "scroll the transcript"),
                ("alt+⌫", "delete a word"),
                ("y / n", "allow or deny a pending approval"),
                ("ctrl+o", "show or hide tool output and programs"),
                ("click", "open the file a tool row names in the IDE"),
                ("⌫", "on an empty prompt, drop the last reference"),
            ];
            if self.tabbed {
                commands.extend([
                    ("ctrl+t", "open a tab"),
                    ("ctrl+w", "close this tab"),
                    ("ctrl+1-9", "go to a tab"),
                    ("ctrl+[ ]", "previous or next tab"),
                ]);
            }
            for (command, what) in commands {
                lines.push(indented(Line::from(vec![
                    Span::styled(format!("{command:<11}"), Style::new().fg(palette().accent)),
                    Span::styled(what, Style::new().fg(palette().muted)),
                ])));
            }
            lines.push(Line::default());
        }

        // Each line wraps on its own, so the rows add up line by line.
        let mut rows = Vec::with_capacity(lines.len() + 1);
        let mut row = 0;
        for line in &lines {
            rows.push(row);
            row += Paragraph::new(line.clone())
                .wrap(Wrap { trim: false })
                .line_count(width);
        }
        rows.push(row);
        self.rows = rows;
        self.links = links;
        self.toggles = toggles;
        self.starts = starts;
        self.fills = fills;
        self.blocks = blocks;
        self.receipts = receipts;
        self.lines = lines;
        self.built_for = Some((width, palette()));
    }

    /// The block whose header a cell lands on, and the file it opens when the cell is on its path.
    fn block_at(&self, cell: Position) -> Option<(&blocks::BlockRow, bool)> {
        if !self.body.contains(cell) {
            return None;
        }
        let row = self.top + usize::from(cell.y - self.body.y);
        let column = cell.x - self.body.x;
        self.blocks
            .iter()
            .find(|b| self.rows.get(b.line) == Some(&row))
            .map(|b| {
                let on_path = b
                    .path_cols
                    .is_some_and(|(from, to)| (from..to).contains(&column));
                (b, on_path)
            })
    }

    /// The blocks the keys can stop on: the ones that open or close, or open a file.
    fn stops(&self) -> Vec<&blocks::BlockRow> {
        self.blocks
            .iter()
            .filter(|b| b.expanded.is_some() || b.open.is_some())
            .collect()
    }

    /// Move the transcript's cursor by `step` stops, from the last one when it has none.
    fn step_cursor(&mut self, step: isize) {
        let stops = self.stops();
        if stops.is_empty() {
            self.cursor = None;
            return;
        }
        let at = self
            .cursor
            .as_ref()
            .and_then(|key| stops.iter().position(|b| &b.key == key));
        let next = match at {
            None => stops.len() - 1,
            Some(at) => at.saturating_add_signed(step).min(stops.len() - 1),
        };
        self.cursor = Some(stops[next].key.clone());
        self.reveal = true;
    }

    /// The tool row a cell lands on, if a click opens it.
    fn link_at(&self, cell: Position) -> Option<&Open> {
        if !self.body.contains(cell) {
            return None;
        }
        let row = self.top + usize::from(cell.y - self.body.y);
        self.links
            .iter()
            .find(|(line, _)| self.rows.get(*line) == Some(&row))
            .map(|(_, open)| open)
    }

    /// The tool row a cell lands on, if a click shows or hides its result.
    fn toggle_at(&self, cell: Position) -> Option<&str> {
        if !self.body.contains(cell) {
            return None;
        }
        let row = self.top + usize::from(cell.y - self.body.y);
        self.toggles
            .iter()
            .find(|(line, _)| self.rows.get(*line) == Some(&row))
            .map(|(_, id)| id.as_str())
    }

    /// Show or hide one tool's result.
    fn toggle(&mut self, id: &str) {
        if !self.disclosed.remove(id) {
            self.disclosed.insert(id.to_owned());
        }
        let shown = self.top..self.top + usize::from(self.body.height);
        self.anchor = self
            .blocks
            .iter()
            .find(|b| b.key == id)
            .and_then(|b| self.rows.get(b.line).copied())
            .filter(|row| shown.contains(row))
            .map(|row| (id.to_owned(), row - self.top));
        self.built_for = None;
    }

    /// The single-session bar: what this is and where.
    fn header(&self) -> Line<'static> {
        let mut spans = vec![Span::styled(
            " ◆ agent",
            Style::new().fg(palette().sage).bold(),
        )];
        if !self.snapshot.project.is_empty() {
            spans.push(Span::styled(
                format!(" · {}", self.snapshot.project),
                Style::new().fg(palette().muted),
            ));
        }
        Line::from(spans)
    }

    fn draw_body(&mut self, buf: &mut Buffer, area: Rect) {
        let inner = area.inner(ratatui::layout::Margin::new(1, 0));
        if self.built_for != Some((inner.width, palette())) {
            self.build(inner.width);
        }
        let paragraph = Paragraph::new(self.lines.clone()).wrap(Wrap { trim: false });
        let total = paragraph.line_count(inner.width);
        let height = inner.height as usize;
        self.page = height.saturating_sub(2).max(1);
        let max_back = total.saturating_sub(height);
        if let Some(index) = self.pin.take() {
            let row = self.starts.get(index).and_then(|line| self.rows.get(*line));
            if let Some(&row) = row {
                self.scroll_back = max_back.saturating_sub(row);
            }
        }
        if let Some((key, offset)) = self.anchor.take() {
            let row = self
                .blocks
                .iter()
                .find(|b| b.key == key)
                .and_then(|b| self.rows.get(b.line).copied());
            if let Some(row) = row {
                self.scroll_back = max_back.saturating_sub(row.saturating_sub(offset));
            }
        }
        if std::mem::take(&mut self.reveal) {
            let row = self
                .cursor
                .as_ref()
                .and_then(|key| self.blocks.iter().find(|b| &b.key == key))
                .and_then(|b| self.rows.get(b.line).copied());
            if let Some(row) = row {
                let top = max_back.saturating_sub(self.scroll_back.min(max_back));
                if row < top {
                    self.scroll_back = max_back.saturating_sub(row);
                } else if row >= top + height {
                    self.scroll_back = max_back.saturating_sub(row + 1 - height.max(1));
                }
            }
        }
        self.scroll_back = self.scroll_back.min(max_back);
        let top = (max_back - self.scroll_back).min(u16::MAX as usize) as u16;
        self.body = inner;
        self.top = usize::from(top);
        // A filled line's background runs the width of each row it wraps
        // to; painted first, so the words it changed keep their own.
        let shown = self.top..self.top + height;
        for &(line, fill) in &self.fills {
            let (Some(&first), Some(&end)) = (self.rows.get(line), self.rows.get(line + 1)) else {
                continue;
            };
            for row in first.max(shown.start)..end.min(shown.end) {
                let y = inner.y + (row - shown.start) as u16;
                let row = Rect::new(inner.x, y, inner.width, 1);
                buf.set_style(row, Style::new().bg(fill));
            }
        }
        paragraph.scroll((top, 0)).render(inner, buf);
        // The block the keys are on sits on the selected band, across its header row.
        let row = self
            .cursor
            .as_ref()
            .and_then(|key| self.blocks.iter().find(|b| &b.key == key))
            .and_then(|b| self.rows.get(b.line).copied());
        if let Some(row) = row.filter(|row| shown.contains(row)) {
            let p = palette();
            let y = inner.y + (row - shown.start) as u16;
            buf.set_style(
                Rect::new(inner.x, y, inner.width, 1),
                Style::new().bg(p.selected_row.unwrap_or(p.selection)),
            );
        }
    }

    fn draw_status(&mut self, buf: &mut Buffer, area: Rect) {
        if self
            .notice
            .as_ref()
            .is_some_and(|(_, until)| *until < now())
        {
            self.notice = None;
        }
        let approval = self
            .snapshot
            .approval
            .as_ref()
            .filter(|_| !self.approval_elsewhere);
        let left = if let Some(approval) = approval {
            Line::from(vec![
                Span::styled(
                    " ? ",
                    Style::new()
                        .fg(palette().approval)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    format!("{} ", approval.tool),
                    Style::new().fg(palette().bright),
                ),
                Span::styled(approval.summary.clone(), Style::new().fg(palette().muted)),
            ])
        } else if self.snapshot.running {
            Line::from(vec![
                Span::styled(
                    format!(" {} ", spinner()),
                    Style::new().fg(palette().accent),
                ),
                Span::styled(
                    self.snapshot
                        .activity
                        .clone()
                        .unwrap_or_else(|| "working".to_owned()),
                    Style::new().fg(palette().muted),
                ),
            ])
        } else if let Some((text, _)) = &self.notice {
            Line::styled(format!(" {text}"), Style::new().fg(palette().accent))
        } else {
            Line::default()
        };
        left.render(area, buf);
        let right = if approval.is_some() {
            "y allow · n deny ".to_owned()
        } else if self.scroll_back > 0 {
            format!("↓ {} more · pgdn ", self.scroll_back)
        } else if self.snapshot.running && !self.hint_in_footer {
            "enter sends · ctrl+c stop ".to_owned()
        } else if let Some(branches) = self.snapshot.branches {
            format!(
                "branch {} of {} · alt+[ ] ",
                branches.position, branches.total
            )
        } else if self.has_output {
            let what = if self.expanded { "hide" } else { "show" };
            format!("ctrl+o {what} output ")
        } else {
            String::new()
        };
        // The panel names how much activity shows, after the hint, for a click to change it.
        let label = if self.activity_control {
            format!("{} ", self.level.label())
        } else {
            String::new()
        };
        let joint = if label.is_empty() || right.is_empty() {
            ""
        } else {
            "· "
        };
        let cols = |text: &str| {
            u16::try_from(unicode_width::UnicodeWidthStr::width(text)).unwrap_or(u16::MAX)
        };
        let label_cols = cols(&label);
        self.level_area = if label.is_empty() {
            Rect::default()
        } else {
            Rect::new(
                area.right().saturating_sub(label_cols),
                area.y,
                label_cols.min(area.width),
                1.min(area.height),
            )
        };
        // Span-styled: a styled Line would repaint the status drawn under it.
        Line::from(vec![
            Span::styled(right, Style::new().fg(palette().muted)),
            Span::styled(joint, Style::new().fg(palette().muted)),
            Span::styled(label, Style::new().fg(palette().muted)),
        ])
        .right_aligned()
        .render(area, buf);
    }

    /// What the next turn carries, over the prompt.
    fn draw_references(&self, buf: &mut Buffer, area: Rect) {
        let mut spans = vec![Span::styled(" with ", Style::new().fg(palette().muted))];
        for (index, label) in self.snapshot.references.iter().enumerate() {
            if index > 0 {
                spans.push(Span::styled(" · ", Style::new().fg(palette().muted)));
            }
            spans.push(Span::styled(
                format!("@{label}"),
                Style::new().fg(palette().link),
            ));
        }
        Line::from(spans).render(area, buf);
        if self.input.value().is_empty() {
            // Span-styled: a styled Line would repaint the labels drawn under it.
            Line::from(Span::styled(
                "⌫ drops the last ",
                Style::new().fg(palette().muted),
            ))
            .right_aligned()
            .render(area, buf);
        }
    }

    /// Draws the prompt line and returns the cell its cursor sits on.
    fn draw_prompt(&self, buf: &mut Buffer, area: Rect, focused: bool) -> Position {
        let block = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(if focused {
                palette().sage
            } else {
                palette().line
            }));
        let inner = block.inner(area);
        block.render(area, buf);

        let lead = PROMPT.chars().count() as u16 + 1;
        let width = inner.width.saturating_sub(lead) as usize;
        Line::from(vec![
            Span::raw(" "),
            Span::styled(PROMPT, Style::new().fg(palette().accent).bold()),
        ])
        .render(inner, buf);
        // The terminal's own cursor is the caret, so the field draws none.
        let styles = FieldStyles {
            text: Style::new().fg(palette().bright),
            selection: Style::new().add_modifier(Modifier::REVERSED),
            caret: Style::new(),
            hint: Style::new().fg(palette().muted),
        };
        let rect = Rect::new(inner.x + lead, inner.y, width as u16, 1);
        self.input.draw(buf, rect, &styles, false, "");
        let scroll = self.input.scroll(width);
        let column = self.input.cursor_cells().saturating_sub(scroll) as u16;
        Position::new(inner.x + lead + column, inner.y)
    }

    fn submit(&mut self) -> Option<Action> {
        let text = self.input.value().trim().to_owned();
        if text.is_empty() {
            return None;
        }
        if self.history.last() != Some(&text) {
            self.history.push(text.clone());
        }
        self.history_at = None;
        self.input = TextField::default();
        self.scroll_back = 0;
        match text.as_str() {
            "/new" => Some(Action::New),
            "/help" => {
                self.help = !self.help;
                self.built_for = None;
                None
            }
            command if command.starts_with('/') && !command.contains(' ') => {
                self.notify(format!("{command} is not a command; /help lists them"));
                None
            }
            // Sending is not stopping: the run takes it at its next step.
            _ if self.snapshot.running => Some(Action::Input(text)),
            _ => Some(Action::Submit(text)),
        }
    }

    fn recall(&mut self, older: bool) {
        if self.history.is_empty() {
            return;
        }
        let next = match (self.history_at, older) {
            (None, true) => Some(self.history.len() - 1),
            (None, false) => return,
            (Some(0), true) => Some(0),
            (Some(at), true) => Some(at - 1),
            (Some(at), false) if at + 1 < self.history.len() => Some(at + 1),
            (Some(_), false) => None,
        };
        self.history_at = next;
        self.input = TextField::new(next.map_or("", |at| self.history[at].as_str()));
    }

    /// The keys that act on the transcript alone: paging, back to the tail and
    /// showing output. A panel that edits its own draft calls this for the keys
    /// its editor did not take; the plain terminal's `key` is unchanged.
    fn transcript_key(&mut self, event: KeyEvent) -> bool {
        match (event.code, event.ctrl) {
            (KeyCode::PageUp, _) => self.scroll_back += self.page,
            (KeyCode::PageDown, _) => self.scroll_back = self.scroll_back.saturating_sub(self.page),
            (KeyCode::Char('l'), true) => self.scroll_back = 0,
            (KeyCode::Char('o'), true) => {
                self.expanded = !self.expanded;
                self.built_for = None;
            }
            _ => return false,
        }
        true
    }

    /// A key that edits the prompt: the shared field's keys, with the modifiers this terminal has
    /// always given them. Alt or Ctrl with Backspace and Alt with an arrow make a word's motion
    /// or deletion; Ctrl with an arrow is a character's; Alt does not stop a character typing.
    fn edit(&mut self, event: &KeyEvent) {
        let (key, mut mods) = match event.code {
            KeyCode::Char(c) => (Key::Char(c), Mods::empty()),
            KeyCode::Backspace => (Key::Backspace, Mods::empty()),
            KeyCode::Delete => (Key::Delete, Mods::empty()),
            KeyCode::Left => (Key::Left, Mods::empty()),
            KeyCode::Right => (Key::Right, Mods::empty()),
            KeyCode::Home => (Key::Home, Mods::empty()),
            KeyCode::End => (Key::End, Mods::empty()),
            _ => return,
        };
        match key {
            Key::Char(_) if event.ctrl => mods |= Mods::CTRL,
            Key::Backspace if event.ctrl || event.alt => mods |= Mods::ALT,
            Key::Left | Key::Right if event.alt => mods |= Mods::ALT,
            _ => {}
        }
        if event.shift {
            mods |= Mods::SHIFT;
        }
        self.input.key(&KeyInput::new(key, mods));
    }

    /// Returns whether the key was the terminal's, so React can keep it from the page.
    fn key(&mut self, event: KeyEvent) -> (bool, Option<Action>) {
        let (code, ctrl) = (event.code.clone(), event.ctrl);
        let action = match code {
            KeyCode::Enter => self.submit(),
            KeyCode::Esc => Some(Action::Close),
            // A selection makes ctrl+c a copy and ctrl+x a cut; without one ctrl+c keeps its
            // old meaning and ctrl+x is not the terminal's.
            KeyCode::Char(c @ ('c' | 'x')) if ctrl && self.input.selection().is_some() => {
                self.input.selected_text().map(|text| Action::Clipboard {
                    text,
                    cut: c == 'x',
                })
            }
            KeyCode::Char('c') if ctrl => {
                if self.snapshot.running {
                    Some(Action::Cancel)
                } else {
                    self.input = TextField::default();
                    None
                }
            }
            KeyCode::Char('l') if ctrl => {
                self.scroll_back = 0;
                None
            }
            KeyCode::Char('o') if ctrl => {
                self.expanded = !self.expanded;
                self.built_for = None;
                None
            }
            KeyCode::Char('a' | 'e' | 'u' | 'k') if ctrl => {
                self.edit(&event);
                None
            }
            KeyCode::Char(_) if ctrl => return (false, None),
            KeyCode::Char(c @ ('y' | 'n'))
                if self.snapshot.approval.is_some() && self.input.value().is_empty() =>
            {
                Some(Action::Approve(c == 'y'))
            }
            KeyCode::Char(_) => {
                self.edit(&event);
                self.history_at = None;
                None
            }
            KeyCode::Backspace
                if self.input.value().is_empty() && !self.snapshot.references.is_empty() =>
            {
                Some(Action::Unreference)
            }
            KeyCode::Backspace
            | KeyCode::Delete
            | KeyCode::Left
            | KeyCode::Right
            | KeyCode::Home
            | KeyCode::End => {
                self.edit(&event);
                None
            }
            KeyCode::Up => {
                self.recall(true);
                None
            }
            KeyCode::Down => {
                self.recall(false);
                None
            }
            KeyCode::PageUp => {
                self.scroll_back += self.page;
                None
            }
            KeyCode::PageDown => {
                self.scroll_back = self.scroll_back.saturating_sub(self.page);
                None
            }
            // Focus stays in the terminal, as in a real one.
            KeyCode::Tab => None,
            _ => return (false, None),
        };
        (true, action)
    }

    /// A Command chord on the prompt, which a Mac's keyboard uses where others use Ctrl: select
    /// all, copy, cut, and a line's motion or deletion. Every other one stays the browser's, a
    /// copy or cut with nothing selected in the prompt included.
    fn command(&mut self, code: KeyCode, shift: bool) -> (bool, Option<Action>) {
        let key = match code {
            KeyCode::Char(c @ ('a' | 'c' | 'x')) => Key::Char(c),
            KeyCode::Left => Key::Left,
            KeyCode::Right => Key::Right,
            KeyCode::Backspace => Key::Backspace,
            KeyCode::Delete => Key::Delete,
            _ => return (false, None),
        };
        let mods = if shift {
            Mods::CMD | Mods::SHIFT
        } else {
            Mods::CMD
        };
        let cut = match self.input.key(&KeyInput::new(key, mods)) {
            Keyed::Handled => return (true, None),
            Keyed::Copy => false,
            Keyed::Cut => true,
            Keyed::Ignored | Keyed::Paste => return (false, None),
        };
        let action = self
            .input
            .selected_text()
            .map(|text| Action::Clipboard { text, cut });
        (true, action)
    }

    /// The clipboard's answer to a copy or cut of `text`. A cut takes the selection out only
    /// when the clipboard has the text and the prompt still holds that same selection; a
    /// refusal leaves the prompt as it was and says so.
    fn clipboard_done(&mut self, text: &str, cut: bool, refusal: Option<&str>) {
        match refusal {
            None => {
                if cut && finish_cut(&mut self.input, text) {
                    self.history_at = None;
                }
            }
            Some(reason) => {
                let what = if cut { "Not cut" } else { "Not copied" };
                self.notify(format!("{what}: {reason}"));
            }
        }
    }

    fn paste(&mut self, text: &str) {
        let text: String = text
            .chars()
            .map(|c| {
                if matches!(c, '\n' | '\r' | '\t') {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        self.input.insert(&text);
        self.history_at = None;
    }
}

/// Why a run did not take input, in the person's words.
fn refusal(reason: Option<&str>) -> Option<&'static str> {
    match reason? {
        "run_ended" => Some("the run ended first"),
        "run_cancelled" => Some("the run was stopped"),
        "run_input_unsupported" => Some("this run takes no input"),
        "answer_final" | "report_captured" => Some("its answer was already final"),
        _ => None,
    }
}

/// Words sent to a working run: a prompt line like the person's own, dim
/// until the run takes them, with what happened to them after.
fn sent_lines(sent: &Sent) -> Vec<Line<'static>> {
    let taken = sent.status == "delivered";
    let (glyph, ink) = if taken {
        (
            Style::new().fg(palette().accent).bold(),
            Style::new().fg(palette().bright),
        )
    } else {
        (
            Style::new().fg(palette().muted),
            Style::new().fg(palette().ink),
        )
    };
    let (tag, tag_style) = sent_tag(sent);
    let rows: Vec<&str> = sent.text.lines().collect();
    let last = rows.len().saturating_sub(1);
    rows.iter()
        .enumerate()
        .map(|(index, row)| {
            let mut spans = vec![
                if index == 0 {
                    Span::styled(PROMPT, glyph)
                } else {
                    Span::raw(INDENT)
                },
                Span::styled((*row).to_owned(), ink),
            ];
            if index == last
                && let Some(tag) = &tag
            {
                spans.push(Span::styled(format!("  · {tag}"), tag_style));
            }
            Line::from(spans)
        })
        .collect()
}

/// What became of words sent to a working run, in plain words, and the colour they are said in.
fn sent_tag(sent: &Sent) -> (Option<String>, Style) {
    match sent.status.as_str() {
        "delivered" => (None, Style::new().fg(palette().muted)),
        "sending" => (Some("sending".to_owned()), Style::new().fg(palette().muted)),
        "next" => (
            Some("goes as the next turn".to_owned()),
            Style::new().fg(palette().warning),
        ),
        "resent" => (
            Some("sent as the next turn".to_owned()),
            Style::new().fg(palette().muted),
        ),
        "not_delivered" => (
            Some(match refusal(sent.reason.as_deref()) {
                Some(why) => format!("not delivered: {why}"),
                None => "not delivered".to_owned(),
            }),
            Style::new().fg(palette().error),
        ),
        "uncertain" => (
            Some("not known whether it was received; it is not sent again".to_owned()),
            Style::new().fg(palette().warning),
        ),
        "failed" => (
            Some(match &sent.reason {
                Some(why) => format!("not sent: {why}"),
                None => "not sent".to_owned(),
            }),
            Style::new().fg(palette().error),
        ),
        _ => (
            Some("queued for its next step".to_owned()),
            Style::new().fg(palette().muted),
        ),
    }
}

/// An answered approval, one line where it was asked: the answer, then what was asked.
fn receipt_line(text: &str, outcome: &str) -> Line<'static> {
    let p = palette();
    let (glyph, word, style) = match outcome {
        "approved" => ("✓", "Allowed", Style::new().fg(p.success)),
        "declined" => ("✗", "Denied", Style::new().fg(p.error)),
        "failed" => ("✗", "The answer failed", Style::new().fg(p.error)),
        _ => ("·", "Not answered", Style::new().fg(p.muted)),
    };
    indented(Line::from(vec![
        Span::styled(format!("{glyph} {word}: "), style),
        Span::styled(text.to_owned(), Style::new().fg(p.muted)),
    ]))
}

/// One tool's row. A row that opens a file underlines its summary, as a
/// terminal draws a hyperlink.
fn tool_row(name: &str, summary: &str, status: &str, link: bool, width: u16) -> Line<'static> {
    tool_row_extra(name, summary, status, link, width, Vec::new()).0
}

/// A tool row with spans after its summary (a time, a diff's counts), and the columns its
/// summary spans, for a click on a path.
fn tool_row_extra(
    name: &str,
    summary: &str,
    status: &str,
    link: bool,
    width: u16,
    extra: Vec<Span<'static>>,
) -> (Line<'static>, (u16, u16)) {
    // A row's state is a register (the glyph) on a ground (the row): a finished or
    // interrupted call sits on the completed ground, one that waits on a decision on the
    // pending ground, one that failed on the failed ground, and a running one is the
    // accent on the running block.
    let p = palette();
    let (glyph, color, ground, name_ink) = match status {
        "complete" => ("✓", p.success, p.completed_row(), p.completed_ink()),
        "error" => ("✗", p.error, p.failed_row(), p.bright),
        "approval" => ("?", p.approval, p.pending_row(), p.bright),
        "interrupted" => ("⊘", p.warning, p.completed_row(), p.bright),
        _ => ("◌", p.accent, p.running_row(), p.bright),
    };
    let lead = format!("{INDENT}{glyph} ");
    let extra_cols: usize = extra.iter().map(|span| span.content.chars().count()).sum();
    let used = lead.chars().count() + name.chars().count() + 2;
    let room = (width as usize).saturating_sub(used + extra_cols);
    let mut summary: String = summary.replace('\n', " ");
    if summary.chars().count() > room {
        summary = summary
            .chars()
            .take(room.saturating_sub(1))
            .collect::<String>()
            + "…";
    }
    let from = used;
    let to = used + summary.chars().count();
    let fill = (width as usize).saturating_sub(to + extra_cols);
    let mut spans = vec![
        Span::styled(lead, Style::new().fg(color)),
        Span::styled(name.to_owned(), Style::new().fg(name_ink).bold()),
        Span::raw("  "),
        Span::styled(
            summary,
            if link {
                Style::new().fg(p.muted).add_modifier(Modifier::UNDERLINED)
            } else {
                Style::new().fg(p.muted)
            },
        ),
    ];
    spans.extend(extra);
    spans.push(Span::raw(" ".repeat(fill)));
    let cols = (
        u16::try_from(from).unwrap_or(u16::MAX),
        u16::try_from(to).unwrap_or(u16::MAX),
    );
    (Line::from(spans).style(Style::new().bg(ground)), cols)
}

/// The terminal's tabs, one session each, and what spans them: focus, the
/// tab bar's click targets and the prompt cursor. A single-session terminal
/// has one tab and draws its header in place of the bar.
struct App {
    tabbed: bool,
    sessions: Vec<Session>,
    active: usize,
    focused: bool,
    /// The last key or focus, so the cursor holds solid while typing.
    typed_at: f64,
    /// The prompt cursor's cell at the last draw.
    cursor: Option<Position>,
    /// The backend's cell size in CSS pixels, for clicks and the cursor.
    cell: (f32, f32),
    /// Tab bar targets at the last draw: start and end columns on `tab_row`.
    hits: Vec<(u16, u16, Hit)>,
    tab_row: u16,
    /// The prompt's area at the last draw, the one place that takes typing.
    prompt: Rect,
}

impl App {
    fn new(tabbed: bool) -> Self {
        Self {
            tabbed,
            sessions: Vec::new(),
            active: 0,
            focused: false,
            typed_at: 0.0,
            cursor: None,
            cell: (0.0, 0.0),
            hits: Vec::new(),
            tab_row: 0,
            prompt: Rect::default(),
        }
    }

    /// Takes React's tab list, keeping each surviving tab's prompt and scroll.
    fn set_tabs(&mut self, json: &str) -> Result<(), serde_json::Error> {
        let list: TabList = serde_json::from_str(json)?;
        let tabbed = self.tabbed;
        let mut old = std::mem::take(&mut self.sessions);
        self.sessions = list
            .tabs
            .into_iter()
            .map(|entry| match old.iter().position(|s| s.id == entry.id) {
                Some(at) => {
                    let mut session = old.swap_remove(at);
                    session.title = visible(&entry.title);
                    session
                }
                None => Session::new(entry.id, visible(&entry.title), tabbed),
            })
            .collect();
        self.active = self
            .sessions
            .iter()
            .position(|s| s.id == list.active)
            .unwrap_or(0);
        Ok(())
    }

    fn set_state(&mut self, tab: &str, json: &str) -> Result<(), serde_json::Error> {
        match self.sessions.iter_mut().find(|s| s.id == tab) {
            Some(session) => session.set_state(json),
            None => Ok(()),
        }
    }

    fn tab(&self, index: usize, action: Action) -> Option<(Action, String)> {
        self.sessions.get(index).map(|s| (action, s.id.clone()))
    }

    fn draw(&mut self, frame: &mut Frame) {
        let area = frame.area();
        // The conversation sits on the canvas, as Theo does in the workbench.
        frame.render_widget(
            Block::new().style(Style::new().bg(palette().canvas()).fg(palette().ink)),
            area,
        );
        let referenced = self
            .sessions
            .get(self.active)
            .is_some_and(|session| !session.snapshot.references.is_empty());
        let [header, body, status, references, prompt] = Layout::vertical([
            Constraint::Length(2),
            Constraint::Fill(1),
            Constraint::Length(1),
            Constraint::Length(u16::from(referenced)),
            Constraint::Length(3),
        ])
        .areas(area);

        let block = Block::new()
            .borders(Borders::BOTTOM)
            .border_style(Style::new().fg(palette().line));
        let bar = block.inner(header);
        frame.render_widget(block, header);
        // The bar's last columns stay clear for the page's close button.
        if self.tabbed {
            self.draw_tabs(
                frame,
                Rect {
                    width: bar.width.saturating_sub(CLOSE_COLUMNS),
                    ..bar
                },
            );
        } else if let Some(session) = self.sessions.get(self.active) {
            frame.render_widget(session.header(), bar);
        }

        self.cursor = None;
        self.prompt = prompt;
        let Some(session) = self.sessions.get_mut(self.active) else {
            return;
        };
        session.draw_body(frame.buffer_mut(), body);
        session.draw_status(frame.buffer_mut(), status);
        if referenced {
            session.draw_references(frame.buffer_mut(), references);
        }
        self.cursor = Some(session.draw_prompt(frame.buffer_mut(), prompt, self.focused));
    }

    /// The tab bar: Ratatui's Tabs, with a spinner on running tabs, a close
    /// mark on the active one and a trailing tab that opens another.
    fn draw_tabs(&mut self, frame: &mut Frame, area: Rect) {
        let spin = spinner();
        let mut titles: Vec<Line<'static>> = self
            .sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                let mut spans = Vec::new();
                if session.snapshot.approval.is_some() {
                    spans.push(Span::styled("? ", Style::new().fg(palette().approval)));
                } else if session.snapshot.running {
                    spans.push(Span::styled(
                        format!("{spin} "),
                        Style::new().fg(palette().accent),
                    ));
                }
                let mut title: String = session.title.chars().take(18).collect();
                if session.title.chars().count() > 18 {
                    title.pop();
                    title.push('…');
                }
                spans.push(Span::raw(title));
                if index == self.active {
                    spans.push(Span::styled(" ×", Style::new().fg(palette().muted)));
                }
                Line::from(spans)
            })
            .collect();
        titles.push(Line::raw("+"));

        // The same walk Tabs makes: padding, title, padding, then a divider
        // between titles.
        self.hits.clear();
        self.tab_row = area.y;
        let last = titles.len() - 1;
        let mut x = area.x;
        for (index, title) in titles.iter().enumerate() {
            let start = x;
            x += title.width() as u16 + 2;
            if index == last {
                self.hits.push((start, x, Hit::New));
            } else if index == self.active {
                self.hits.push((start, x - 2, Hit::Select(index)));
                self.hits.push((x - 2, x, Hit::Close(index)));
            } else {
                self.hits.push((start, x, Hit::Select(index)));
            }
            x += 1;
        }

        frame.render_widget(
            Tabs::new(titles)
                .select(self.active)
                .style(Style::new().fg(palette().muted))
                .highlight_style(
                    Style::new()
                        .fg(palette().bright)
                        .add_modifier(Modifier::BOLD),
                )
                .divider(Span::styled("│", Style::new().fg(palette().line)))
                .padding(" ", " "),
            area,
        );
    }

    /// Tab keys first, then the active session's.
    fn key(&mut self, event: KeyEvent) -> (bool, Option<(Action, String)>) {
        self.typed_at = now();
        let count = self.sessions.len();
        if count == 0 {
            return (false, None);
        }
        if self.tabbed && event.ctrl {
            let action = match event.code {
                KeyCode::Char('t') => self.tab(self.active, Action::NewTab),
                KeyCode::Char('w') => self.tab(self.active, Action::CloseTab),
                KeyCode::Char(c @ '1'..='9') => {
                    self.tab(c as usize - '1' as usize, Action::SelectTab)
                }
                KeyCode::Char('[') => {
                    self.tab((self.active + count - 1) % count, Action::SelectTab)
                }
                KeyCode::Char(']') => self.tab((self.active + 1) % count, Action::SelectTab),
                _ => None,
            };
            if action.is_some() {
                return (true, action);
            }
        }
        let session = &mut self.sessions[self.active];
        let (handled, action) = session.key(event);
        (handled, action.map(|action| (action, session.id.clone())))
    }

    /// A Command chord, which is only ever the active session's prompt's.
    fn command(&mut self, event: KeyEvent) -> (bool, Option<(Action, String)>) {
        let active = self.active;
        let Some(session) = self.sessions.get_mut(active) else {
            return (false, None);
        };
        let (handled, action) = session.command(event.code, event.shift);
        if handled {
            self.typed_at = now();
        }
        let id = self.sessions[active].id.clone();
        (handled, action.map(|action| (action, id)))
    }

    /// A press at CSS pixels from the terminal's top left.
    /// The cell under a point in CSS pixels from the terminal's top left.
    fn cell_at(&self, x: f64, y: f64) -> Option<Position> {
        let (width, height) = self.cell;
        if width <= 0.0 || height <= 0.0 || x < 0.0 || y < 0.0 {
            return None;
        }
        Some(Position::new(
            (x / f64::from(width)) as u16,
            (y / f64::from(height)) as u16,
        ))
    }

    /// The tab bar target under a point, if any.
    fn hit_at(&self, x: f64, y: f64) -> Option<Hit> {
        let cell = self.cell_at(x, y)?;
        if !self.tabbed || cell.y != self.tab_row {
            return None;
        }
        self.hits
            .iter()
            .find(|(start, end, _)| (*start..*end).contains(&cell.x))
            .map(|(_, _, hit)| *hit)
    }

    /// The active session's tool row under a point that a click opens.
    fn link_at(&self, x: f64, y: f64) -> Option<&Open> {
        let cell = self.cell_at(x, y)?;
        self.sessions.get(self.active)?.link_at(cell)
    }

    /// The CSS cursor for a point: a pointer over the tab bar's targets and
    /// the rows that open a file, a text cursor over the prompt, and the
    /// arrow everywhere else.
    fn cursor_at(&self, x: f64, y: f64) -> &'static str {
        if self.hit_at(x, y).is_some() || self.link_at(x, y).is_some() {
            "pointer"
        } else if self
            .cell_at(x, y)
            .is_some_and(|cell| self.prompt.contains(cell))
        {
            "text"
        } else {
            "default"
        }
    }

    fn click(&self, x: f64, y: f64) -> Option<(Action, String)> {
        if let Some(open) = self.link_at(x, y) {
            return self.tab(self.active, Action::Open(open.clone()));
        }
        match self.hit_at(x, y)? {
            Hit::Select(index) => self.tab(index, Action::SelectTab),
            Hit::Close(index) => self.tab(index, Action::CloseTab),
            Hit::New => self.tab(self.active, Action::NewTab),
        }
    }
}

/// How a view's own text caret is drawn: the overlay element's inline style, and where the
/// hidden input field goes so an IME's candidate window opens at the caret.
struct CaretStyle {
    overlay: String,
    field: String,
}

/// What a `Screen` draws each frame: the agent terminal or the cabinet.
trait Drawn {
    /// The backend's cell size in CSS pixels, measured each frame.
    fn set_cell(&mut self, cell: (f32, f32));
    fn draw(&mut self, frame: &mut Frame);
    /// The hollow cursor: its cell, whether the view is focused, and when it
    /// last took a key. None hides it.
    fn caret(&self) -> Option<(Position, bool, f64)> {
        None
    }
    /// A view that times its own text caret (the workbench) answers here with how to draw it;
    /// the screen then paints that instead of the hollow prompt cursor.
    fn text_caret(&self, _now: f64) -> Option<CaretStyle> {
        None
    }
    /// Called after each draw, so a view can report what moved.
    fn drawn(&mut self) {}
    /// Called each frame with the grid's area before drawing. A view that
    /// returns false keeps what it last drew: the frame is neither drawn nor
    /// diffed.
    fn wants_frame(&mut self, _area: Rect) -> bool {
        true
    }
    /// The grid was rebuilt blank, so the next frame must draw everything.
    fn repaint(&mut self) {}
}

impl Drawn for App {
    fn set_cell(&mut self, cell: (f32, f32)) {
        self.cell = cell;
    }
    fn draw(&mut self, frame: &mut Frame) {
        App::draw(self, frame);
    }
    fn caret(&self) -> Option<(Position, bool, f64)> {
        self.cursor.map(|at| (at, self.focused, self.typed_at))
    }
}

/// Starts `navigator.clipboard.writeText`; an error is why it could not start.
fn clipboard_write(text: &str) -> Result<js_sys::Promise, String> {
    let none = || "this browser has no clipboard here".to_owned();
    let window = web_sys::window().ok_or_else(none)?;
    let clipboard = js_sys::Reflect::get(&window.navigator(), &"clipboard".into())
        .ok()
        .filter(|c| !c.is_undefined() && !c.is_null())
        .ok_or_else(none)?;
    let write: js_sys::Function = js_sys::Reflect::get(&clipboard, &"writeText".into())
        .ok()
        .and_then(|f| f.dyn_into().ok())
        .ok_or_else(none)?;
    write
        .call1(&clipboard, &JsValue::from_str(text))
        .map_err(|error| clipboard_reason(&error))?
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| none())
}

/// The words for a clipboard failure: the error's message, or a plain refusal.
fn clipboard_reason(error: &JsValue) -> String {
    let message = error.as_string().or_else(|| {
        js_sys::Reflect::get(error, &"message".into())
            .ok()
            .and_then(|m| m.as_string())
    });
    match message.filter(|m| !m.is_empty()) {
        Some(message) => escaped(&message),
        None => "the browser refused the clipboard".to_owned(),
    }
}

/// The mounted terminal. React calls these from its own event handlers.
#[wasm_bindgen]
pub struct TerminalHandle {
    app: Rc<RefCell<App>>,
    on_action: js_sys::Function,
}

#[wasm_bindgen]
impl TerminalHandle {
    fn emit(&self, action: Option<(Action, String)>) {
        if let Some((action, tab)) = action {
            if let Action::Clipboard { text, cut } = action {
                self.write_clipboard(tab, text, cut);
                return;
            }
            let _ = self
                .on_action
                .call1(&JsValue::NULL, &JsValue::from_str(&action.to_json(&tab)));
        }
    }

    /// Writes to the browser's clipboard and tells the session how it went.
    fn write_clipboard(&self, tab: String, text: String, cut: bool) {
        let settle = |app: &Rc<RefCell<App>>, tab: &str, text: &str, refusal: Option<&str>| {
            let mut app = app.borrow_mut();
            if let Some(session) = app.sessions.iter_mut().find(|s| s.id == tab) {
                session.clipboard_done(text, cut, refusal);
            }
        };
        match clipboard_write(&text) {
            Err(reason) => settle(&self.app, &tab, &text, Some(&reason)),
            Ok(promise) => {
                let (app, tab_ok, text_ok) = (self.app.clone(), tab.clone(), text.clone());
                let taken = Closure::once(move |_: JsValue| {
                    let mut app = app.borrow_mut();
                    if let Some(session) = app.sessions.iter_mut().find(|s| s.id == tab_ok) {
                        session.clipboard_done(&text_ok, cut, None);
                    }
                });
                let app = self.app.clone();
                let refused = Closure::once(move |error: JsValue| {
                    let reason = clipboard_reason(&error);
                    let mut app = app.borrow_mut();
                    if let Some(session) = app.sessions.iter_mut().find(|s| s.id == tab) {
                        session.clipboard_done(&text, cut, Some(&reason));
                    }
                });
                let _ = promise.then2(&taken, &refused);
                taken.forget();
                refused.forget();
            }
        }
    }

    /// Replaces the tabs with React's list (JSON `{tabs: [{id, title}], active}`).
    pub fn set_tabs(&self, json: &str) -> Result<(), JsValue> {
        self.app
            .borrow_mut()
            .set_tabs(json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Replaces a tab's transcript with React's latest snapshot (JSON).
    pub fn set_state(&self, tab: &str, json: &str) -> Result<(), JsValue> {
        self.app
            .borrow_mut()
            .set_state(tab, json)
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    /// Handles a keydown; true when the terminal used it.
    pub fn key(&self, event: KeyboardEvent) -> bool {
        // The borrow ends before React hears the action, which may set state.
        // A Command chord never types: the prompt takes the few it knows, the browser the rest.
        let command = event.meta_key();
        let (handled, action) = if command {
            self.app.borrow_mut().command(event.into())
        } else {
            self.app.borrow_mut().key(event.into())
        };
        self.emit(action);
        handled
    }

    /// Handles a press at CSS pixels from the terminal's top left.
    pub fn click(&self, x: f64, y: f64) {
        let action = self.app.borrow().click(x, y);
        self.emit(action);
    }

    /// The CSS cursor for a point in CSS pixels from the terminal's top left.
    pub fn cursor(&self, x: f64, y: f64) -> String {
        self.app.borrow().cursor_at(x, y).to_owned()
    }

    pub fn paste(&self, text: &str) {
        let mut app = self.app.borrow_mut();
        app.typed_at = now();
        let active = app.active;
        if let Some(session) = app.sessions.get_mut(active) {
            session.paste(text);
        }
    }

    /// Scrolls the transcript; positive is towards newer output.
    pub fn scroll(&self, lines: i32) {
        let mut app = self.app.borrow_mut();
        let active = app.active;
        if let Some(session) = app.sessions.get_mut(active) {
            session.scroll_back = if lines < 0 {
                session.scroll_back + lines.unsigned_abs() as usize
            } else {
                session.scroll_back.saturating_sub(lines as usize)
            };
        }
    }

    pub fn set_focused(&self, focused: bool) {
        let mut app = self.app.borrow_mut();
        app.focused = focused;
        app.typed_at = now();
    }
}

/// The Ratatui terminal on the backend's grid, kept the grid's size.
struct Screen {
    terminal: Terminal<DomBackend>,
    parent: web_sys::Element,
    window: web_sys::Window,
    /// The parent's size in cells at the last frame.
    measured: (u16, u16),
    /// Set by the window's resize event, on which the backend rebuilds its grid blank.
    rebuilt: Rc<Cell<bool>>,
    _on_resize: Closure<dyn FnMut()>,
    /// A hollow block over the prompt's cursor cell. Ratzilla's cursors are
    /// a filled block or an underline, neither blinking, so the screen draws
    /// its own on top of the grid.
    cursor: web_sys::Element,
    cursor_style: String,
    /// The workbench's hidden input field, found once; it follows the caret.
    field: Option<web_sys::HtmlElement>,
    field_style: String,
}

impl Screen {
    fn new(parent_id: &str) -> Result<Self, JsValue> {
        let error = |e: &dyn std::fmt::Display| JsValue::from_str(&e.to_string());
        let window = web_sys::window().ok_or("no window")?;
        let document = window.document().ok_or("no document")?;
        let parent = document
            .get_element_by_id(parent_id)
            .ok_or("no terminal element")?;
        let cursor = document.create_element("div")?;
        cursor.set_attribute("aria-hidden", "true")?;
        let backend = DomBackend::new_by_id(parent_id).map_err(|e| error(&e))?;
        let terminal = Terminal::with_options(
            backend,
            TerminalOptions {
                viewport: Viewport::Fixed(Rect::default()),
            },
        )
        .map_err(|e| error(&e))?;
        let rebuilt = Rc::new(Cell::new(true));
        let flag = rebuilt.clone();
        let on_resize = Closure::<dyn FnMut()>::new(move || flag.set(true));
        window.add_event_listener_with_callback("resize", on_resize.as_ref().unchecked_ref())?;
        Ok(Self {
            terminal,
            parent,
            window,
            measured: (0, 0),
            rebuilt,
            _on_resize: on_resize,
            cursor,
            cursor_style: String::new(),
            field: None,
            field_style: String::new(),
        })
    }

    fn send_resize(&self) {
        if let Ok(event) = Event::new("resize") {
            let _ = self.window.dispatch_event(&event);
        }
    }

    fn frame<D: Drawn>(&mut self, app: &mut D) -> std::io::Result<()> {
        let (cell_w, cell_h) = self.terminal.backend().cell_size_css_px();
        app.set_cell((cell_w, cell_h));
        let rect = self.parent.get_bounding_client_rect();
        let measured = (
            (rect.width() / f64::from(cell_w)) as u16,
            (rect.height() / f64::from(cell_h)) as u16,
        );
        // A closed drawer is display: none; nothing to draw until it opens.
        if measured.0 == 0 || measured.1 == 0 {
            self.measured = measured;
            return Ok(());
        }
        if measured != self.measured {
            self.measured = measured;
            // The drawer resized without the window; the backend only
            // rebuilds its grid on the window's resize event.
            self.send_resize();
        }
        if self.rebuilt.replace(false) {
            // An empty draw lets the backend rebuild and measure its grid;
            // the viewport then takes that size and the next draw is whole.
            self.terminal.resize(Rect::default())?;
            // It re-measures only a grid already on the page, and the first
            // was measured while the closed drawer had no size, so a first
            // build is drawn twice.
            if !self.parent.has_child_nodes() {
                self.terminal.draw(|_| {})?;
                self.send_resize();
                self.rebuilt.set(false);
            }
            self.terminal.draw(|_| {})?;
            let size = self.terminal.backend_mut().window_size()?.columns_rows;
            self.terminal
                .resize(Rect::new(0, 0, size.width, size.height))?;
            app.repaint();
        }
        let area = self.terminal.get_frame().area();
        if area.width > 0 && area.height > 0 && app.wants_frame(area) {
            self.terminal.draw(|frame| app.draw(frame))?;
            app.drawn();
        }
        self.place_cursor(app, (cell_w, cell_h));
        Ok(())
    }

    /// Moves the hollow cursor to the prompt: blinking while focused, solid
    /// for a beat after each key, steady and dim while unfocused.
    fn place_cursor<D: Drawn>(&mut self, app: &D, cell: (f32, f32)) {
        // A rebuild empties the parent, cursor included.
        if !self.cursor.is_connected() {
            let _ = self.parent.append_child(&self.cursor);
        }
        if let Some(caret) = app.text_caret(now()) {
            if caret.overlay != self.cursor_style {
                let _ = self.cursor.set_attribute("style", &caret.overlay);
                self.cursor_style = caret.overlay;
            }
            self.place_field(&caret.field);
            return;
        }
        let style = match app.caret() {
            Some((at, focused, typed_at)) => {
                let lit = !focused || (((now() - typed_at) / BLINK_MS) as u64).is_multiple_of(2);
                let color = match (lit, focused) {
                    (false, _) => "transparent".to_owned(),
                    (true, true) => palette().sage.to_string(),
                    (true, false) => palette().idle.to_string(),
                };
                let (width, height) = cell;
                format!(
                    "position:absolute;pointer-events:none;box-sizing:border-box;\
                     border:1px solid {color};left:{}px;top:{}px;width:{width}px;height:{height}px",
                    f32::from(at.x) * width,
                    f32::from(at.y) * height,
                )
            }
            None => "display:none".to_owned(),
        };
        if style != self.cursor_style {
            let _ = self.cursor.set_attribute("style", &style);
            self.cursor_style = style;
        }
    }
}

impl Screen {
    /// Moves the hidden input field to the caret's cell.
    fn place_field(&mut self, style: &str) {
        if style == self.field_style {
            return;
        }
        if self.field.is_none() {
            self.field = self
                .parent
                .parent_element()
                .and_then(|wrapper| {
                    wrapper
                        .query_selector(&format!(
                            "textarea[aria-label='{} input']",
                            theorem_workbench_core::panels::WORKBENCH_LABEL
                        ))
                        .ok()
                        .flatten()
                })
                .and_then(|element| element.dyn_into::<web_sys::HtmlElement>().ok());
        }
        if let Some(field) = &self.field {
            let _ = field.set_attribute("style", style);
            self.field_style = style.to_owned();
        }
    }
}

impl Drop for Screen {
    /// The window outlives the screen; its listener must not call a freed closure.
    fn drop(&mut self) {
        let _ = self.window.remove_event_listener_with_callback(
            "resize",
            self._on_resize.as_ref().unchecked_ref(),
        );
    }
}

/// Draws a frame on every animation frame until the element leaves the page.
fn run_frames<D: Drawn + 'static>(mut screen: Screen, app: Rc<RefCell<D>>) {
    type Frame = Rc<RefCell<Option<Closure<dyn FnMut()>>>>;
    let next: Frame = Rc::new(RefCell::new(None));
    let scheduled = next.clone();
    *next.borrow_mut() = Some(Closure::new(move || {
        if !screen.parent.is_connected() {
            // Dropping the closure ends the loop and frees the terminal.
            scheduled.borrow_mut().take();
            return;
        }
        if let Err(error) = screen.frame(&mut *app.borrow_mut()) {
            web_sys::console::error_1(&JsValue::from_str(&format!("terminal: {error}")));
        }
        if let Some(callback) = scheduled.borrow().as_ref() {
            let _ = screen
                .window
                .request_animation_frame(callback.as_ref().unchecked_ref());
        }
    }));
    if let (Some(window), Some(callback)) = (web_sys::window(), next.borrow().as_ref()) {
        let _ = window.request_animation_frame(callback.as_ref().unchecked_ref());
    }
}

/// Mounts the terminal into the element with `parent_id`, which it fills and
/// which must be positioned (the cursor sits on it absolutely). `tabbed` draws
/// a tab bar; without it the terminal shows its one tab's header. Tabs come
/// from `set_tabs`. `on_action` receives each action as a JSON string. Frames
/// run until the element leaves the page; mount once per element.
#[wasm_bindgen]
pub fn mount(
    parent_id: &str,
    tabbed: bool,
    on_action: js_sys::Function,
) -> Result<TerminalHandle, JsValue> {
    let screen = Screen::new(parent_id)?;
    let app = Rc::new(RefCell::new(App::new(tabbed)));
    run_frames(screen, app.clone());
    Ok(TerminalHandle { app, on_action })
}

/// Renders one artifact preview (the worker calls this). `source_json` is a
/// `preview::Source`; `rgba` is the decoded image when there is one, empty
/// otherwise. Returns `{meta, indices}` where `indices` is the 128×84 indexed
/// raster as a byte array, so presentation is a palette lookup.
#[wasm_bindgen]
pub fn render_preview(
    source_json: &str,
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<JsValue, JsValue> {
    let source: preview::Source = serde_json::from_str(source_json)
        .map_err(|e| JsValue::from_str(&format!("malformed preview source: {e}")))?;
    let pixels = (!rgba.is_empty()).then_some(preview::Pixels {
        rgba,
        width,
        height,
    });
    let result = preview::render(&source, pixels.as_ref());
    let out = js_sys::Object::new();
    let meta =
        serde_json::to_string(&result.meta()).map_err(|e| JsValue::from_str(&e.to_string()))?;
    js_sys::Reflect::set(&out, &"meta".into(), &JsValue::from_str(&meta))?;
    js_sys::Reflect::set(
        &out,
        &"indices".into(),
        &js_sys::Uint8Array::from(result.raster.indices.as_slice()),
    )?;
    Ok(out.into())
}

/// The preview palette as `{id, version, colours: ["#rrggbb", …]}` in index
/// order, so the page paints a raster's indices with the colours it was
/// converted against.
#[wasm_bindgen]
pub fn preview_palette() -> String {
    let colours: Vec<String> = preview::palette::REFERENCE
        .iter()
        .map(|(_, [r, g, b])| format!("#{r:02x}{g:02x}{b:02x}"))
        .collect();
    serde_json::json!({
        "id": preview::palette::PALETTE_ID,
        "version": preview::palette::PALETTE_VERSION,
        "colours": colours,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The row's text and, for each run of one style, where it starts.
    fn fingerprint(buf: &Buffer, area: Rect) -> String {
        let mut text = String::new();
        let mut runs = Vec::new();
        let mut last = None;
        for x in area.x..area.right() {
            let cell = &buf[(x, area.y)];
            // The spinner turns with the clock; its cell is not the row's wording.
            let symbol = if x == area.x + 1 && SPINNER.contains(&cell.symbol()) {
                "*"
            } else {
                cell.symbol()
            };
            text.push_str(symbol);
            let style = (cell.fg, cell.bg, cell.modifier);
            if last != Some(style) {
                runs.push(format!(
                    "{}:{:?}/{:?}/{:?}",
                    x - area.x,
                    style.0,
                    style.1,
                    style.2
                ));
                last = Some(style);
            }
        }
        format!("{text}|{}", runs.join(" "))
    }

    fn row(session: &mut Session) -> String {
        let area = Rect::new(0, 0, 60, 1);
        let mut buf = Buffer::empty(area);
        session.draw_status(&mut buf, area);
        fingerprint(&buf, area)
    }

    fn session(json: &str) -> Session {
        let mut session = Session::new("t".into(), "T".into(), false);
        session.snapshot = serde_json::from_str(json).unwrap();
        session
    }

    /// The ground colour of an empty classic terminal's last cell.
    fn ground() -> Color {
        let mut terminal =
            ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 12)).unwrap();
        let mut app = App::new(false);
        terminal.draw(|frame| app.draw(frame)).unwrap();
        terminal.backend().buffer()[(39, 0)].bg
    }

    #[test]
    fn the_classic_terminal_sits_on_the_canvas_and_on_the_panel_ground_without_one() {
        assert_eq!(ground(), palette().bg);
        let mut laddered = palette();
        laddered.canvas = Some(Color::Rgb(0x10, 0x18, 0x20));
        PALETTE.set(laddered);
        assert_eq!(ground(), Color::Rgb(0x10, 0x18, 0x20));
    }

    #[test]
    fn a_hostile_tool_name_and_summary_are_spelled_out_in_the_approval_row_and_never_reorder_it() {
        let hostile = "\u{202e}\u{1b}[31m\u{200b}\u{7}";
        let json = serde_json::json!({
            "approval": {"tool": format!("rm{hostile}"), "summary": format!("tmp{hostile}")},
            "error": format!("bad{hostile}"),
        })
        .to_string();
        let mut s = Session::new("t".into(), "T".into(), false);
        s.set_state(&json).unwrap();
        let spelled = "\\u{202e}\\u{1b}[31m\\u{200b}\\u{7}";
        assert_eq!(
            s.snapshot.approval.as_ref().unwrap().tool,
            format!("rm{spelled}")
        );
        assert_eq!(
            s.snapshot.approval.as_ref().unwrap().summary,
            format!("tmp{spelled}")
        );
        let area = Rect::new(0, 0, 120, 1);
        let mut buf = Buffer::empty(area);
        s.draw_status(&mut buf, area);
        let shown: String = (0..120).map(|x| buf[(x, 0)].symbol()).collect();
        assert!(shown.contains(&format!("rm{spelled}")), "{shown:?}");
        assert!(
            !shown
                .chars()
                .any(|c| c.is_control() || theorem_workbench_text::visible::hidden(c)),
            "{shown:?}"
        );
    }

    fn press(s: &mut Session, code: KeyCode, ctrl: bool, shift: bool) {
        s.key(KeyEvent {
            code,
            ctrl,
            alt: false,
            shift,
        });
    }

    /// A prompt holding "hello world" with "lo wo" selected.
    fn selected_prompt() -> Session {
        let mut s = Session::new("t".into(), "T".into(), false);
        s.input.insert("hello world");
        for _ in 0..3 {
            press(&mut s, KeyCode::Left, false, false);
        }
        for _ in 0..5 {
            press(&mut s, KeyCode::Left, false, true);
        }
        assert_eq!(s.input.selected_text().as_deref(), Some("lo wo"));
        s
    }

    fn chord(s: &mut Session, c: char) -> Option<Action> {
        s.key(KeyEvent {
            code: KeyCode::Char(c),
            ctrl: true,
            alt: false,
            shift: false,
        })
        .1
    }

    #[test]
    fn command_chords_select_copy_and_cut_the_prompt_and_leave_the_rest_to_the_browser() {
        let mut s = selected_prompt();
        let (handled, action) = s.command(KeyCode::Char('c'), false);
        assert!(handled);
        assert!(
            matches!(action, Some(Action::Clipboard { ref text, cut: false }) if text == "lo wo")
        );
        let (_, action) = s.command(KeyCode::Char('x'), false);
        assert!(
            matches!(action, Some(Action::Clipboard { ref text, cut: true }) if text == "lo wo")
        );
        // The cut waits for the clipboard's answer.
        assert_eq!(s.input.value(), "hello world");
        assert!(s.command(KeyCode::Char('a'), false).0);
        assert_eq!(s.input.selected_text().as_deref(), Some("hello world"));
        assert!(s.command(KeyCode::Left, false).0);
        assert_eq!(s.input.selected_text(), None);
        assert!(s.command(KeyCode::Right, true).0);
        assert_eq!(s.input.selected_text().as_deref(), Some("hello world"));
        assert!(s.command(KeyCode::Right, false).0);
        // With nothing selected a copy is the browser's, and so is a chord the prompt does not
        // know; none of them types.
        for c in ['c', 'x', 'r', 'k', 'v'] {
            let (handled, action) = s.command(KeyCode::Char(c), false);
            assert!(!handled && action.is_none(), "{c}");
        }
        assert_eq!(s.input.value(), "hello world");
        assert!(s.command(KeyCode::Backspace, false).0);
        assert_eq!(s.input.value(), "");
    }

    #[test]
    fn copying_the_prompt_selection_sends_exactly_the_selection_and_changes_nothing() {
        let mut s = selected_prompt();
        let Some(Action::Clipboard { text, cut }) = chord(&mut s, 'c') else {
            panic!("ctrl+c with a selection is a copy");
        };
        assert_eq!((text.as_str(), cut), ("lo wo", false));
        assert_eq!(s.input.value(), "hello world");
        assert_eq!(s.input.selected_text().as_deref(), Some("lo wo"));
    }

    #[test]
    fn a_cut_the_clipboard_took_removes_the_selection() {
        let mut s = selected_prompt();
        let Some(Action::Clipboard { text, cut }) = chord(&mut s, 'x') else {
            panic!("ctrl+x with a selection is a cut");
        };
        assert!(cut);
        assert_eq!(
            s.input.value(),
            "hello world",
            "nothing goes before the answer"
        );
        s.clipboard_done(&text, cut, None);
        assert_eq!(s.input.value(), "helrld");
    }

    #[test]
    fn a_refused_cut_keeps_the_text_and_says_so() {
        let mut s = selected_prompt();
        s.clipboard_done("lo wo", true, Some("permission denied"));
        assert_eq!(s.input.value(), "hello world");
        assert_eq!(s.input.selected_text().as_deref(), Some("lo wo"));
        assert_eq!(s.notice.as_ref().unwrap().0, "Not cut: permission denied");
        s.clipboard_done("lo wo", false, Some("permission denied"));
        assert_eq!(
            s.notice.as_ref().unwrap().0,
            "Not copied: permission denied"
        );
    }

    #[test]
    fn a_cut_after_the_selection_changed_removes_nothing() {
        let mut s = selected_prompt();
        press(&mut s, KeyCode::Left, false, false);
        s.clipboard_done("lo wo", true, None);
        assert_eq!(s.input.value(), "hello world");
    }

    #[test]
    fn without_a_selection_ctrl_c_still_clears_the_prompt_and_stops_a_run() {
        let mut s = Session::new("t".into(), "T".into(), false);
        s.input.insert("hello");
        assert!(chord(&mut s, 'c').is_none());
        assert_eq!(s.input.value(), "");
        assert!(chord(&mut s, 'x').is_none());
        s.snapshot.running = true;
        assert!(matches!(chord(&mut s, 'c'), Some(Action::Cancel)));
    }

    #[test]
    fn shift_left_then_typing_replaces_in_the_prompt_and_select_all_replaces_it_all() {
        let mut s = Session::new("t".into(), "T".into(), false);
        for c in "hello".chars() {
            press(&mut s, KeyCode::Char(c), false, false);
        }
        press(&mut s, KeyCode::Left, false, true);
        press(&mut s, KeyCode::Left, false, true);
        press(&mut s, KeyCode::Char('X'), false, false);
        assert_eq!(s.input.value(), "helX");
        press(&mut s, KeyCode::Char('a'), true, false);
        press(&mut s, KeyCode::Char('y'), false, false);
        assert_eq!(s.input.value(), "y");
    }

    #[test]
    fn a_paste_replaces_the_selection_and_lands_on_one_line() {
        let mut s = Session::new("t".into(), "T".into(), false);
        for c in "hello".chars() {
            press(&mut s, KeyCode::Char(c), false, false);
        }
        press(&mut s, KeyCode::Char('a'), true, false);
        s.paste("a\nb");
        assert_eq!(s.input.value(), "a b");
    }

    #[test]
    fn a_notice_with_hostile_characters_is_spelled_out() {
        let mut s = Session::new("t".into(), "T".into(), false);
        s.notify("saved \u{202e}name\u{7}");
        assert_eq!(s.notice.as_ref().unwrap().0, "saved \\u{202e}name\\u{7}");
    }

    // The status row as the plain terminal drew it before `hint_in_footer`
    // existed; the spinner cell is masked.
    const GOLDEN_IDLE: &str =
        "                                                            |0:Reset/Reset/NONE";
    const GOLDEN_ACTIVITY: &str = " * reading src/panel.rs           enter sends · ctrl+c stop |0:Rgb(138, 168, 160)/Reset/NONE 3:Rgb(143, 152, 160)/Reset/NONE 23:Reset/Reset/NONE 34:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_WORKING: &str = " * working                        enter sends · ctrl+c stop |0:Rgb(138, 168, 160)/Reset/NONE 3:Rgb(143, 152, 160)/Reset/NONE 10:Reset/Reset/NONE 34:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_APPROVAL: &str = " ? edit_file Write src/panel.rs            y allow · n deny |0:Rgb(214, 188, 138)/Reset/BOLD 3:Rgb(228, 234, 238)/Reset/NONE 13:Rgb(143, 152, 160)/Reset/NONE 31:Reset/Reset/NONE 43:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_BRANCH: &str = "                                    branch 2 of 3 · alt+[ ] |0:Reset/Reset/NONE 36:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_OUTPUT: &str = "                                         ctrl+o show output |0:Reset/Reset/NONE 41:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_SCROLLED: &str = "                                            ↓ 4 more · pgdn |0:Reset/Reset/NONE 44:Rgb(143, 152, 160)/Reset/NONE";
    const GOLDEN_NOTICE: &str = " copied                                                     |0:Rgb(138, 168, 160)/Reset/NONE";

    #[test]
    fn the_plain_terminal_draws_its_status_row_as_before() {
        let cases = [
            ("{}", GOLDEN_IDLE),
            (
                r#"{"running":true,"activity":"reading src/panel.rs"}"#,
                GOLDEN_ACTIVITY,
            ),
            (r#"{"running":true}"#, GOLDEN_WORKING),
            (
                r#"{"approval":{"tool":"edit_file","summary":"Write src/panel.rs"}}"#,
                GOLDEN_APPROVAL,
            ),
            (r#"{"branches":{"position":2,"total":3}}"#, GOLDEN_BRANCH),
        ];
        for (json, golden) in cases {
            assert!(!session(json).hint_in_footer);
            assert_eq!(row(&mut session(json)), golden, "{json}");
        }
        let mut s = session("{}");
        s.has_output = true;
        assert_eq!(row(&mut s), GOLDEN_OUTPUT);
        let mut s = session("{}");
        s.scroll_back = 4;
        assert_eq!(row(&mut s), GOLDEN_SCROLLED);
        let mut s = session("{}");
        s.notify("copied");
        assert_eq!(row(&mut s), GOLDEN_NOTICE);
    }

    #[test]
    fn a_footer_that_owns_the_hint_takes_only_the_send_hint_off_the_row() {
        let mut working = session(r#"{"running":true}"#);
        working.hint_in_footer = true;
        let got = row(&mut working);
        assert!(got.starts_with(" * working "), "{got}");
        assert!(!got.contains("enter sends"), "{got}");
        assert!(!got.contains("ctrl+c stop"), "{got}");
        // What only the status row knows stays.
        for (json, golden) in [
            (
                r#"{"approval":{"tool":"edit_file","summary":"Write src/panel.rs"}}"#,
                GOLDEN_APPROVAL,
            ),
            (r#"{"branches":{"position":2,"total":3}}"#, GOLDEN_BRANCH),
        ] {
            let mut s = session(json);
            s.hint_in_footer = true;
            assert_eq!(row(&mut s), golden, "{json}");
        }
        let mut s = session(r#"{"running":true,"branches":{"position":2,"total":3}}"#);
        s.hint_in_footer = true;
        assert!(row(&mut s).contains("branch 2 of 3"));
        let mut s = session("{}");
        s.hint_in_footer = true;
        s.notify("copied");
        assert_eq!(row(&mut s), GOLDEN_NOTICE);
    }
}
