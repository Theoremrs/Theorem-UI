//! What the language owner answers a hover, a completion, a navigation, a
//! reference search and a check with, and how the editor shows it.
//!
//! Every answer is about one revision of the text. It is applied only while
//! that is the accepted revision and no edit is waiting on top of it: the
//! positions in it are in the owner's units, and they mean nothing in a text
//! that has moved. An answer that arrives too late is not applied and the
//! status line says so.

use ratatui::style::Style;
use theorem_workbench_core::completion::{Completion, CompletionPayload, Outcome};
use theorem_workbench_core::effect::{EffectBody, LanguageNavigate, LanguagePosition};
use theorem_workbench_core::results::{
    CompletionItem, CompletionRange, Finding, LocationRow, Range, Severity, Span, SpanEncoding,
};
use theorem_workbench_core::{Ctx, OpenTarget};

use super::{Doc, EditorPanel, Task, Tone, reveal_offset, seq};
use crate::actions::Choice;
use crate::panel::flow::emit_notice;
use crate::styles::EditorStyles;
use crate::widget::Mark;

/// Rows a list shows at once.
pub(crate) const LIST_ROWS: usize = 8;

/// A popup over the text, next to the caret.
pub(crate) enum Popup {
    Hover {
        revision: u64,
        version: u64,
        contents: String,
        /// The first line shown.
        top: usize,
    },
    Completions {
        revision: u64,
        version: u64,
        items: Vec<CompletionItem>,
        selected: usize,
        top: usize,
    },
    Places {
        title: &'static str,
        revision: u64,
        rows: Vec<Place>,
        selected: usize,
        top: usize,
    },
}

pub(crate) struct Place {
    pub label: String,
    pub target: Target,
}

pub(crate) enum Target {
    /// A scalar offset in this document.
    Here(usize),
    /// A place in another document of the workspace; both from 1, the column
    /// in UTF-16 code units.
    There {
        path: String,
        line: u32,
        column: u32,
    },
    /// A place the owner named by a URI, which no editor of the workspace can open.
    Outside(String),
}

impl Popup {
    /// Rows to choose among, or none for a hover.
    pub fn len(&self) -> usize {
        match self {
            Popup::Hover { .. } => 0,
            Popup::Completions { items, .. } => items.len(),
            Popup::Places { rows, .. } => rows.len(),
        }
    }

    pub fn selected(&self) -> Option<usize> {
        match self {
            Popup::Hover { .. } => None,
            Popup::Completions { selected, .. } | Popup::Places { selected, .. } => Some(*selected),
        }
    }

    pub fn step(&mut self, by: isize) {
        let n = self.len() as isize;
        if n == 0 {
            return;
        }
        if let Popup::Completions { selected, top, .. } | Popup::Places { selected, top, .. } = self
        {
            *selected = (*selected as isize + by).clamp(0, n - 1) as usize;
            // The row the keys are on stays in view.
            if *selected < *top {
                *top = *selected;
            } else if *selected >= *top + LIST_ROWS {
                *top = *selected + 1 - LIST_ROWS;
            }
        }
    }

    fn top_mut(&mut self) -> &mut usize {
        match self {
            Popup::Hover { top, .. }
            | Popup::Completions { top, .. }
            | Popup::Places { top, .. } => top,
        }
    }

    /// How many rows a popup of this kind shows at most.
    pub fn cap(&self) -> usize {
        if self.selected().is_some() {
            LIST_ROWS
        } else {
            10
        }
    }

    /// The first row shown and how many, in `height` rows of room.
    pub fn window(&self, height: usize) -> (usize, usize) {
        let total = match self {
            Popup::Hover { contents, .. } => hover_lines(contents).len(),
            _ => self.len(),
        };
        let shown = total.min(self.cap()).min(height);
        let top = match self {
            Popup::Hover { top, .. }
            | Popup::Completions { top, .. }
            | Popup::Places { top, .. } => *top,
        };
        (top.min(total - shown), shown)
    }

    /// The wheel: the rows move and the choice stays where it is.
    pub fn scroll(&mut self, by: isize, height: usize) {
        let (first, shown) = self.window(height);
        let total = match self {
            Popup::Hover { contents, .. } => hover_lines(contents).len(),
            _ => self.len(),
        };
        *self.top_mut() = (first as isize + by).clamp(0, (total - shown) as isize) as usize;
    }

    /// Choose the row at `index` of the whole list.
    pub fn select(&mut self, index: usize) {
        if let Popup::Completions { selected, .. } | Popup::Places { selected, .. } = self {
            *selected = index;
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Popup::Hover { .. } => "Hover",
            Popup::Completions { .. } => "Completions",
            Popup::Places { title, .. } => title,
        }
    }

    /// The lines it draws and the one that is chosen, as text.
    pub fn rows(&self) -> Vec<String> {
        match self {
            Popup::Hover { contents, .. } => hover_lines(contents),
            Popup::Completions { items, .. } => items
                .iter()
                .map(|i| match &i.detail {
                    Some(detail) => format!("{}  {detail}", i.label),
                    None => i.label.clone(),
                })
                .collect(),
            Popup::Places { rows, .. } => rows.iter().map(|r| r.label.clone()).collect(),
        }
    }
}

/// The Markdown of a hover as plain lines: styled by the Markdown renderer
/// and then flattened, because a popup has one style.
fn hover_lines(markdown: &str) -> Vec<String> {
    tui_markdown::from_str(markdown)
        .lines
        .iter()
        .map(|line| {
            line.spans
                .iter()
                .map(|s| s.content.as_ref())
                .collect::<String>()
        })
        .collect()
}

/// One finding, in scalar offsets of the text it was read against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Item {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub severity: Severity,
    pub message: String,
}

/// The owner's findings for the document.
#[derive(Debug, Default)]
pub(crate) struct Findings {
    /// The revision `items` are about.
    pub revision: Option<u64>,
    pub items: Vec<Item>,
    /// The revision last asked about: one ask per revision, so a refusal is
    /// not asked again until the text changes.
    pub asked: Option<u64>,
    pub inflight: bool,
    /// The owner's reason it gave none, shown in the status line.
    pub problem: Option<String>,
}

impl Findings {
    /// The findings that still fit the text: about the accepted revision with
    /// nothing typed on top of it.
    pub fn current(&self, accepted: u64, pending: bool) -> &[Item] {
        if self.revision == Some(accepted) && !pending {
            &self.items
        } else {
            &[]
        }
    }
}

impl Doc {
    pub fn findings(&self) -> &[Item] {
        self.findings
            .current(self.session.accepted_revision(), self.session.has_pending())
    }

    /// Marks to draw under the text, by severity.
    pub fn marks(&self, styles: &EditorStyles) -> Vec<Mark> {
        let mut marks: Vec<Mark> = self
            .findings()
            .iter()
            .filter(|f| f.start < f.end)
            .map(|f| Mark {
                start: f.start,
                end: f.end,
                style: severity_style(styles, f.severity),
            })
            .collect();
        // Where the agent last edited, over its whole line.
        if let Some(at) = self.followed {
            let coords = self.session.coords();
            let at = at.min(self.session.len());
            if let Some((start, end)) = coords.line_range(coords.line_of(at))
                && start < end
            {
                marks.push(Mark {
                    start,
                    end,
                    style: styles.search_match,
                });
            }
        }
        marks.sort_by_key(|m| m.start);
        marks
    }

    /// The glyph for each line that has a finding: the worst one's.
    pub fn gutter(&self, styles: &EditorStyles) -> Vec<(usize, char, Style)> {
        let coords = self.session.coords();
        let mut worst: Vec<(usize, Severity)> = Vec::new();
        for f in self.findings() {
            let line = coords.line_of(f.start);
            match worst.iter_mut().find(|(l, _)| *l == line) {
                Some((_, s)) if rank(f.severity) < rank(*s) => *s = f.severity,
                Some(_) => {}
                None => worst.push((line, f.severity)),
            }
        }
        worst
            .into_iter()
            .map(|(line, s)| (line, glyph(s), severity_style(styles, s)))
            .collect()
    }

    /// The finding on the caret's line, worst first.
    pub fn finding_here(&self) -> Option<&Item> {
        let coords = self.session.coords();
        let line = coords.line_of(self.session.cursor());
        self.findings()
            .iter()
            .filter(|f| coords.line_of(f.start) == line)
            .min_by_key(|f| (rank(f.severity), f.start))
    }
}

fn rank(s: Severity) -> u8 {
    match s {
        Severity::Error => 0,
        Severity::Warning => 1,
        Severity::Info => 2,
        Severity::Hint => 3,
    }
}

pub(crate) fn glyph(s: Severity) -> char {
    match s {
        Severity::Error => '!',
        Severity::Warning => '?',
        Severity::Info => 'i',
        Severity::Hint => '.',
    }
}

pub(crate) fn word(s: Severity) -> &'static str {
    match s {
        Severity::Error => "error",
        Severity::Warning => "warning",
        Severity::Info => "info",
        Severity::Hint => "hint",
    }
}

fn severity_style(styles: &EditorStyles, s: Severity) -> Style {
    match s {
        Severity::Error => styles.error,
        Severity::Warning => styles.warning,
        Severity::Info => styles.info,
        Severity::Hint => styles.hint,
    }
}

// ---- positions ----------------------------------------------------------------

/// The scalar offset of an LSP position (line from 0, character in UTF-16
/// units), clamped to the line it names.
pub(crate) fn lsp_offset(text: &str, line: u32, character: u32) -> usize {
    reveal_offset(text, line + 1, character + 1)
}

/// The scalar offset of a byte offset, or none when it is past the text or
/// inside a character.
pub(crate) fn byte_offset(text: &str, byte: u64) -> Option<usize> {
    let byte = usize::try_from(byte).ok()?;
    if byte > text.len() || !text.is_char_boundary(byte) {
        return None;
    }
    Some(text[..byte].chars().count())
}

/// A span in the units its encoding names, as scalar offsets of `text`.
pub(crate) fn span_offsets(text: &str, span: &Span) -> Option<(usize, usize)> {
    let one = |at: u64| -> Option<usize> {
        match span.encoding {
            SpanEncoding::Utf8Bytes => byte_offset(text, at),
            SpanEncoding::UnicodeScalars => {
                let at = usize::try_from(at).ok()?;
                (at <= text.chars().count()).then_some(at)
            }
            SpanEncoding::Utf16CodeUnits => {
                let mut units = 0u64;
                for (i, ch) in text.chars().enumerate() {
                    if units == at {
                        return Some(i);
                    }
                    if units > at {
                        return None;
                    }
                    units += ch.len_utf16() as u64;
                }
                (units == at).then(|| text.chars().count())
            }
        }
    };
    let (start, end) = (one(span.start)?, one(span.end)?);
    (start <= end).then_some((start, end))
}

fn range_offsets(text: &str, r: &Range) -> (usize, usize) {
    (
        lsp_offset(text, r.start.line, r.start.character),
        lsp_offset(text, r.end.line, r.end.character),
    )
}

// ---- asking ---------------------------------------------------------------

impl EditorPanel {
    /// The owner's position for the caret.
    fn lsp_position(&self) -> Option<LanguagePosition> {
        let d = self.doc()?;
        let at = d.view.position(&d.session);
        Some(LanguagePosition {
            line: (at.line - 1) as u32,
            character: at.utf16 as u32,
        })
    }

    /// Hover, completion, go to definition and find references: each asks the
    /// owner about the caret at the accepted revision.
    pub(super) fn ask(&mut self, choice: Choice, cx: &mut Ctx) {
        let Some(position) = self.lsp_position() else {
            return;
        };
        let Some(d) = self.doc_mut() else { return };
        let revision = d.session.accepted_revision();
        let version = d.version;
        let (task, body, what) = match choice {
            Choice::Hover => (
                Task::Hover { revision, version },
                EffectBody::LanguageHover(position),
                "asking for the hover",
            ),
            Choice::Complete => (
                Task::Complete { revision, version },
                EffectBody::LanguageComplete(position),
                "asking for completions",
            ),
            Choice::Definition => (
                Task::Navigate {
                    revision,
                    references: false,
                },
                EffectBody::LanguageNavigate(LanguageNavigate {
                    kind: "definition".to_owned(),
                    position,
                }),
                "looking for the definition",
            ),
            _ => (
                Task::Navigate {
                    revision,
                    references: true,
                },
                EffectBody::LanguageReferences(position),
                "looking for references",
            ),
        };
        match self.start(cx, task, body, Some(revision)) {
            Ok(_) => {
                if let Some(d) = self.doc_mut() {
                    d.busy = Some(what);
                    d.popup = None;
                }
            }
            Err(e) => self.say(emit_notice(e), Tone::Warn),
        }
    }

    /// Ask the owner for the findings, as a person asked (`notice`) or because
    /// the text changed under a language service that is there.
    pub(super) fn check(&mut self, cx: &mut Ctx, notice: bool) {
        let Some(d) = self.doc_mut() else { return };
        let revision = d.session.accepted_revision();
        d.findings.asked = Some(revision);
        d.findings.inflight = true;
        match self.start(
            cx,
            Task::Check(revision),
            EffectBody::LanguageDiagnostics,
            Some(revision),
        ) {
            Ok(_) => {}
            Err(e) => {
                if let Some(d) = self.doc_mut() {
                    d.findings.inflight = false;
                    // A silent call is asked again on the next tick.
                    d.findings.asked = None;
                }
                if notice {
                    self.say(emit_notice(e), Tone::Warn);
                }
            }
        }
    }

    /// The tick's share: a check of the accepted text when none has been asked
    /// for it, with nothing typed on top of it.
    pub(super) fn check_due(&mut self, cx: &mut Ctx) {
        if !self.language {
            return;
        }
        let Some(d) = self.doc() else { return };
        let due = d.findings.asked != Some(d.session.accepted_revision())
            && !d.findings.inflight
            && !d.session.has_pending()
            && !d.session.has_conflict()
            && d.sync.desync.is_none();
        if due {
            self.check(cx, false);
        }
    }

    // ---- answers --------------------------------------------------------------

    /// Whether an answer about `asked` still fits the document. When it does
    /// not, the status line says so and nothing is applied.
    fn fits(&mut self, what: &str, asked: u64, stamped: Option<u64>) -> bool {
        let Some(d) = self.doc_mut() else {
            return false;
        };
        let about = stamped.unwrap_or(asked);
        let now = d.session.accepted_revision();
        if about == now && !d.session.has_pending() {
            return true;
        }
        let why = if about != now {
            format!("it is for revision {about} and the document is at {now}")
        } else {
            "edits were typed since".to_owned()
        };
        d.notice(format!("The {what} was not shown: {why}."), Tone::Warn);
        false
    }

    /// The owner's refusal, failure or silence for something asked.
    fn not_answered(&mut self, what: &str, outcome: Outcome) {
        let Some(d) = self.doc_mut() else { return };
        match outcome {
            Outcome::Accepted => d.notice(
                format!("The language service accepted the request and sent no {what}."),
                Tone::Warn,
            ),
            Outcome::Refused { reason, .. } | Outcome::Failed { reason } => {
                d.notice(format!("No {what}: {reason}"), Tone::Error);
            }
            Outcome::Uncertain { reason } => d.notice(
                format!("Unknown whether there is a {what}: {reason}"),
                Tone::Warn,
            ),
        }
    }

    pub(super) fn on_hover(&mut self, revision: u64, version: u64, c: Completion) {
        if let Some(d) = self.doc_mut() {
            d.busy = None;
        }
        let stamped = c.revision.as_ref().and_then(seq);
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguageHover(h))) => {
                if !self.fits("hover", revision, stamped) {
                    return;
                }
                let Some(d) = self.doc_mut() else { return };
                if d.version != version {
                    return;
                }
                if h.contents.trim().is_empty() {
                    d.notice("Nothing to show here.", Tone::Info);
                } else {
                    d.popup = Some(Popup::Hover {
                        revision,
                        version,
                        contents: h.contents,
                        top: 0,
                    });
                }
            }
            (outcome, _) => self.not_answered("hover", outcome),
        }
    }

    pub(super) fn on_completions(&mut self, revision: u64, version: u64, c: Completion) {
        if let Some(d) = self.doc_mut() {
            d.busy = None;
        }
        let stamped = c.revision.as_ref().and_then(seq);
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguageCompletions(list))) => {
                if !self.fits("completion list", revision, stamped) {
                    return;
                }
                let Some(d) = self.doc_mut() else { return };
                if d.version != version {
                    return;
                }
                if list.items.is_empty() {
                    d.notice("No completions here.", Tone::Info);
                } else {
                    d.popup = Some(Popup::Completions {
                        revision,
                        version,
                        items: list.items,
                        selected: 0,
                        top: 0,
                    });
                }
            }
            (outcome, _) => self.not_answered("completion list", outcome),
        }
    }

    pub(super) fn on_places(&mut self, revision: u64, references: bool, c: Completion) {
        if let Some(d) = self.doc_mut() {
            d.busy = None;
        }
        let (title, what) = if references {
            ("References", "reference list")
        } else {
            ("Definitions", "definition")
        };
        let stamped = c.revision.as_ref().and_then(seq);
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguageLocations(list))) => {
                if !self.fits(what, revision, stamped) {
                    return;
                }
                if list.locations.is_empty() {
                    self.say(format!("No {what} found."), Tone::Info);
                    return;
                }
                let path = self.path.clone();
                let Some(d) = self.doc_mut() else { return };
                let text = d.session.text();
                let rows: Vec<Place> = list
                    .locations
                    .iter()
                    .map(|row| place_of(row, &path, &text))
                    .collect();
                d.popup = Some(Popup::Places {
                    title,
                    revision,
                    rows,
                    selected: 0,
                    top: 0,
                });
            }
            (outcome, _) => self.not_answered(what, outcome),
        }
    }

    pub(super) fn on_check(&mut self, revision: u64, c: Completion) {
        let stamped = c.revision.as_ref().and_then(seq);
        let Some(d) = self.doc_mut() else { return };
        d.findings.inflight = false;
        match (c.outcome, c.payload) {
            (Outcome::Accepted, Some(CompletionPayload::LanguageDiagnostics(found))) => {
                let about = found.revision.or(stamped).unwrap_or(revision);
                let now = d.session.accepted_revision();
                if about != now {
                    d.findings.problem = Some(format!(
                        "findings for revision {about} were not shown; the document is at {now}"
                    ));
                    // Ask again for the text that is here.
                    d.findings.asked = None;
                    return;
                }
                d.findings.problem = None;
                let text = d.session.accepted_text();
                let (mut fits, mut skipped) = (Vec::new(), 0usize);
                for f in &found.findings {
                    match item_of(&text, f) {
                        Some(i) => fits.push(i),
                        None => skipped += 1,
                    }
                }
                // A part of the set adds to what is there; the whole replaces it.
                if !found.full && d.findings.revision == Some(about) {
                    let kept: Vec<Item> = d
                        .findings
                        .items
                        .drain(..)
                        .filter(|old| !fits.iter().any(|n| n.id == old.id))
                        .collect();
                    fits.extend(kept);
                }
                fits.sort_by_key(|i| (i.start, i.end));
                d.findings.revision = Some(about);
                d.findings.items = fits;
                if skipped > 0 {
                    d.notice(
                        format!("{skipped} findings did not fit the text and were left out."),
                        Tone::Warn,
                    );
                }
            }
            (Outcome::Accepted, _) => {
                d.findings.problem = Some("the owner sent no findings".to_owned());
            }
            (Outcome::Refused { reason, .. } | Outcome::Failed { reason }, _) => {
                d.findings.problem = Some(reason);
            }
            (Outcome::Uncertain { reason }, _) => {
                d.findings.problem = Some(format!("unknown whether there are findings: {reason}"));
            }
        }
    }

    // ---- choosing a row ---------------------------------------------------------

    /// Take the row the list is on: insert the completion through the normal
    /// edit path, or go to the place.
    pub(super) fn accept_popup(&mut self, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let Some(popup) = d.popup.take() else { return };
        match popup {
            Popup::Hover { .. } => {}
            Popup::Completions {
                revision,
                version,
                items,
                selected,
                ..
            } => {
                let Some(item) = items.into_iter().nth(selected) else {
                    return;
                };
                if d.session.accepted_revision() != revision || d.version != version {
                    d.notice(
                        "The completion list is for text that has changed; ask again.",
                        Tone::Warn,
                    );
                    return;
                }
                self.insert_completion(item);
            }
            Popup::Places {
                revision,
                mut rows,
                selected,
                ..
            } => {
                if selected >= rows.len() {
                    return;
                }
                let place = rows.swap_remove(selected);
                self.go_to(place, revision, cx);
            }
        }
    }

    fn insert_completion(&mut self, item: CompletionItem) {
        let Some(d) = self.doc_mut() else { return };
        let text = d.session.text();
        let insert = item
            .insert_text
            .clone()
            .unwrap_or_else(|| item.label.clone());
        let (start, end) = match item.range {
            Some(CompletionRange::One(r)) => range_offsets(&text, &r),
            Some(CompletionRange::Split { inserting, .. }) => range_offsets(&text, &inserting),
            // No range: the word being typed is what the item completes.
            None => {
                let caret = d.session.cursor();
                let before: Vec<char> = text.chars().take(caret).collect();
                let typed = before
                    .iter()
                    .rev()
                    .take_while(|c| c.is_alphanumeric() || **c == '_')
                    .count();
                (caret - typed, caret)
            }
        };
        d.session.break_undo_group();
        d.session.set_selection(start, end);
        match d.session.insert_text(&insert) {
            Ok(_) => {
                d.session.break_undo_group();
                d.touch();
                d.view.reveal(&mut d.session);
            }
            Err(e) => {
                let note = self.edit_error(&e);
                self.say(note, Tone::Warn);
            }
        }
    }

    fn go_to(&mut self, place: Place, revision: u64, cx: &mut Ctx) {
        match place.target {
            Target::Here(offset) => {
                let Some(d) = self.doc_mut() else { return };
                if d.session.accepted_revision() != revision {
                    d.notice(
                        format!(
                            "That place is for revision {revision} and the document is at {}.",
                            d.session.accepted_revision()
                        ),
                        Tone::Warn,
                    );
                    return;
                }
                let at = offset.min(d.session.len());
                d.session.set_selection(at, at);
                d.view.reveal(&mut d.session);
            }
            Target::There { path, line, column } => cx.open(OpenTarget::FileAt {
                workspace: self.workspace.clone(),
                path,
                line,
                column,
            }),
            Target::Outside(uri) => self.say(
                format!("{uri} is outside the workspace's documents; no editor opens it."),
                Tone::Warn,
            ),
        }
    }
}

fn item_of(text: &str, f: &Finding) -> Option<Item> {
    let start = byte_offset(text, f.start)?;
    let end = byte_offset(text, f.end)?;
    (start <= end).then(|| Item {
        id: f.id.clone(),
        start,
        end,
        severity: f.severity,
        message: f.message.clone(),
    })
}

/// One row of a navigation or reference answer.
fn place_of(row: &LocationRow, here: &str, text: &str) -> Place {
    let uri = || row.uri.clone().unwrap_or_else(|| "(no place)".to_owned());
    let Some(path) = row.resource_id.clone() else {
        return Place {
            label: uri(),
            target: Target::Outside(uri()),
        };
    };
    let range = row.range.or_else(|| {
        // A span names the place in offsets; against another file's text there
        // is nothing to turn them into a line, so only the file opens.
        row.span.as_ref().filter(|_| path == here).and_then(|s| {
            let (a, b) = span_offsets(text, s)?;
            Some(Range {
                start: lsp_of(text, a),
                end: lsp_of(text, b),
            })
        })
    });
    let (line, column) = match range {
        Some(r) => (r.start.line + 1, r.start.character + 1),
        None => (1, 1),
    };
    let label = format!("{path}:{line}:{column}");
    if path == here {
        let at = lsp_offset(text, line - 1, column - 1);
        let snippet: String = text
            .lines()
            .nth((line - 1) as usize)
            .unwrap_or("")
            .trim()
            .chars()
            .take(60)
            .collect();
        Place {
            label: format!("{label}  {snippet}"),
            target: Target::Here(at),
        }
    } else {
        Place {
            label,
            target: Target::There { path, line, column },
        }
    }
}

/// The LSP position of a scalar offset in `text`.
fn lsp_of(text: &str, offset: usize) -> theorem_workbench_core::results::Position {
    let mut line = 0u32;
    let mut character = 0u32;
    for ch in text.chars().take(offset) {
        if ch == '\n' {
            line += 1;
            character = 0;
        } else {
            character += ch.len_utf16() as u32;
        }
    }
    theorem_workbench_core::results::Position { line, character }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_byte_offset_inside_a_character_is_not_a_place() {
        let text = "a\u{4e2d}b";
        assert_eq!(byte_offset(text, 0), Some(0));
        assert_eq!(byte_offset(text, 1), Some(1));
        assert_eq!(byte_offset(text, 2), None, "inside the CJK character");
        assert_eq!(byte_offset(text, 4), Some(2));
        assert_eq!(byte_offset(text, 5), Some(3));
        assert_eq!(byte_offset(text, 6), None, "past the end");
    }

    #[test]
    fn a_span_is_turned_into_scalars_by_its_own_encoding() {
        let text = "a\u{1F600}b";
        let at = |encoding, start, end| {
            span_offsets(
                text,
                &Span {
                    start,
                    end,
                    encoding,
                },
            )
        };
        assert_eq!(at(SpanEncoding::Utf8Bytes, 1, 5), Some((1, 2)));
        assert_eq!(at(SpanEncoding::Utf16CodeUnits, 1, 3), Some((1, 2)));
        assert_eq!(at(SpanEncoding::UnicodeScalars, 1, 2), Some((1, 2)));
        assert_eq!(
            at(SpanEncoding::Utf16CodeUnits, 2, 3),
            None,
            "inside a pair"
        );
        assert_eq!(at(SpanEncoding::Utf8Bytes, 2, 5), None);
    }

    #[test]
    fn a_position_round_trips_between_lsp_and_scalars() {
        let text = "ab\nx\u{1F600}yz\n";
        let offset = lsp_offset(text, 1, 3);
        // Past the emoji: the line starts at scalar 3, and x and the emoji are two scalars.
        assert_eq!(offset, 5);
        let back = lsp_of(text, offset);
        assert_eq!((back.line, back.character), (1, 3));
    }
}
