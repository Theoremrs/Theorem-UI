//! What the panel shows around the text (the find bar, the strip with the
//! owner's refusals and the choices they offer, the status line), the phases
//! before there is a document, and the semantic nodes.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::Style;
use theorem_workbench_core::ViewCtx;
use theorem_workbench_core::host::{ConnectionState, LocalStatus};
use theorem_workbench_core::ids::Revision as CoreRevision;
use theorem_workbench_core::results::Severity;
use theorem_workbench_core::semantics::{Node, NodeAction, NodeId, Role};
use theorem_workbench_text::Caret;
use theorem_workbench_text::recovery::{self, snip};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::language::{Popup, word};
use super::{Doc, EditorPanel, Phase, Tone};
use crate::actions::Choice;
use crate::styles::EditorStyles;
use crate::widget::Paint;

/// Where each part of a ready editor is.
pub(super) struct Frame {
    pub find: Option<Rect>,
    pub text: Rect,
    pub strip: Option<Rect>,
    /// A notice that did not fit on the status line, wrapped above it.
    pub notice: Option<Rect>,
    pub status: Option<Rect>,
}

enum Prompt {
    Text(String, Tone),
    Rename,
    /// The name of a new page, and the owner's word on the last one.
    Name(Option<String>),
}

const NAMING_HELP: &str = "Name the file to create in this workspace.";

/// How the find bar shares its width.
struct FindPlan {
    rows: u16,
    /// What follows the query on the first row: the count and the key hint,
    /// the count alone, or nothing, by what leaves the query room.
    tail: String,
    /// The replace buttons sit after the replacement; if not, they wrap onto
    /// rows of their own under it.
    inline_replace: bool,
}

/// The least a find or replace field is given before the rest gives way.
const FIELD_ROOM: usize = 8;

/// How much a status flag matters, lowest first: the order in which flags give way
/// when the line is too narrow. The flags that warn of unsaved or recovered work are
/// the last to go and are never cut; the others drop whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Rank {
    /// Something in progress or a missing extra: saving, sending, findings.
    Progress,
    /// A standing condition: the connection.
    State,
    /// Unsaved, unconfirmed or recovered work, or edits that cannot be taken: modified,
    /// kept or not kept, save and edit unknown, out of sync, recovered edits waiting,
    /// read-only.
    Work,
}

struct Flag {
    long: String,
    short: String,
    rank: Rank,
}

/// The flags of at least `floor`, in the order they are shown.
fn rank_at_least(flags: &[Flag], floor: Rank) -> Vec<&Flag> {
    flags.iter().filter(|f| f.rank >= floor).collect()
}

/// How the status line and the notice share the width.
struct StatusPlan {
    left: String,
    right: String,
    attention: bool,
    notice: Option<(String, Tone)>,
    /// The notice sits on the status line after the left side.
    notice_inline: bool,
    /// Rows it takes above the line when it does not.
    notice_rows: u16,
}

struct Strip {
    prompt: Prompt,
    buttons: Vec<Choice>,
}

impl Strip {
    /// Rows wanted: the text, wrapped, and the buttons, wrapped.
    fn rows(&self, width: u16) -> u16 {
        let text = match &self.prompt {
            Prompt::Rename => 1,
            Prompt::Name(error) => 1 + u16::from(error.is_some()),
            Prompt::Text(t, _) => wrap(t, width).len().max(1) as u16,
        };
        text + layout_buttons(&self.buttons, width).len() as u16
    }
}

/// `text` broken into rows of at most `width` cells, at spaces where it can.
fn wrap(text: &str, width: u16) -> Vec<String> {
    textwrap::wrap(text, usize::from(width.max(1)))
        .into_iter()
        .map(std::borrow::Cow::into_owned)
        .collect()
}

/// The buttons laid out left to right and wrapped onto as many rows as they
/// need, each with the label to draw. A label is `[Title Chord]`; when that
/// is wider than the row the chord goes first, and only then is the title cut.
fn layout_buttons(buttons: &[Choice], width: u16) -> Vec<Vec<(Choice, String)>> {
    let width = usize::from(width.max(1));
    let mut rows: Vec<Vec<(Choice, String)>> = vec![];
    let mut used = 0;
    for &b in buttons {
        let d = b.descriptor();
        let mut text = label(b);
        if text.width() > width {
            text = format!("[{}]", d.title);
        }
        if text.width() > width {
            text = format!("[{}\u{2026}]", take_cells(d.title, width.saturating_sub(3)));
        }
        let w = text.width();
        match rows.last_mut() {
            Some(row) if used + 1 + w <= width => {
                row.push((b, text));
                used += 1 + w;
            }
            _ => {
                rows.push(vec![(b, text)]);
                used = w;
            }
        }
    }
    rows
}

/// The first `cells` display cells of `text`.
fn take_cells(text: &str, cells: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if n + w > cells {
            break;
        }
        out.push(c);
        n += w;
    }
    out
}

/// The last `cells` display cells of `text`.
fn take_cells_back(text: &str, cells: usize) -> String {
    let mut out: Vec<char> = vec![];
    let mut n = 0;
    for c in text.chars().rev() {
        let w = c.width().unwrap_or(0);
        if n + w > cells {
            break;
        }
        out.push(c);
        n += w;
    }
    out.into_iter().rev().collect()
}

/// `path` in `room` cells. The leading directories give way first (`.../a/b.txt`
/// then `.../b.txt`), then the file name loses its middle (`no...es.txt`), so
/// the name stays whole for as long as any room remains for it.
fn shorten_path(path: &str, room: usize) -> String {
    if path.width() <= room {
        return path.to_owned();
    }
    let parts: Vec<&str> = path.split('/').collect();
    let n = parts.len();
    for keep in (1..n).rev() {
        let cand = format!("\u{2026}/{}", parts[n - keep..].join("/"));
        if cand.width() <= room {
            return cand;
        }
    }
    let name = parts[n - 1];
    if name.width() <= room {
        return name.to_owned();
    }
    match room {
        0 => String::new(),
        1 => "\u{2026}".to_owned(),
        _ => {
            let tail = room / 2;
            let head = room - 1 - tail;
            format!(
                "{}\u{2026}{}",
                take_cells(name, head),
                take_cells_back(name, tail)
            )
        }
    }
}

fn label(choice: Choice) -> String {
    let d = choice.descriptor();
    if d.chord.is_empty() {
        format!("[{}]", d.title)
    } else {
        format!("[{} {}]", d.title, d.chord)
    }
}

impl EditorPanel {
    fn styles(&self, cx: &ViewCtx) -> EditorStyles {
        self.styles
            .clone()
            .unwrap_or_else(|| EditorStyles::from_theme(cx.theme))
    }

    // ---- what is unavailable, and why ------------------------------------

    /// Why `choice` cannot be done now, in words a person can act on.
    pub(super) fn unavailable(&self, choice: Choice) -> Option<String> {
        if choice == Choice::Create {
            return (!self.documents)
                .then(|| "The document service is not available in this workspace.".to_owned());
        }
        let Some(d) = self.doc() else {
            return match choice {
                Choice::Close => None,
                Choice::Retry => match &self.phase {
                    Phase::Failed(p) if p.can_retry => None,
                    Phase::Failed(p) if p.unknown => Some(
                        "The owner did not say whether the file opened, so it is not asked again by guess."
                            .to_owned(),
                    ),
                    Phase::Failed(_) => Some("The owner's answer will not change.".to_owned()),
                    _ => Some("Nothing failed.".to_owned()),
                },
                _ => Some("No document is open.".to_owned()),
            };
        };
        let read_only = || d.sync.read_only.clone().map(|r| format!("Read-only: {r}"));
        let language = || {
            if !self.language {
                Some("No language service in this workspace.".to_owned())
            } else if let Some(r) = read_only() {
                Some(r)
            } else if d.session.has_conflict() {
                Some("Settle the held text first.".to_owned())
            } else if d.session.has_pending() {
                Some("Wait until the owner has accepted the edits.".to_owned())
            } else if d.sync.desync.is_some() {
                Some("Waiting for the owner's text.".to_owned())
            } else if d.busy.is_some() {
                Some("Another request is in flight.".to_owned())
            } else {
                None
            }
        };
        let unplaced = d
            .sync
            .restored
            .as_ref()
            .is_some_and(|r| r.moved_from.is_some());
        let offer = |o| {
            recovery::refusal(
                o,
                d.sync.restored.as_ref().map(|r| r.moved_from.is_none()),
                d.sync.read_only.as_deref(),
            )
        };
        let conflict = || {
            (!d.session.has_conflict() && !unplaced).then(|| "There is no held text.".to_owned())
        };
        match choice {
            Choice::Save => {
                if !self.documents {
                    Some("The document service is not available.".to_owned())
                } else if d.session.has_conflict() {
                    Some("Settle the held text first.".to_owned())
                } else if d.sync.desync.is_some() {
                    Some("Waiting for the owner's text.".to_owned())
                } else if d.sync.save.inflight == Some(d.session.accepted_revision())
                    && !d.session.has_pending()
                {
                    Some("A save of this revision is already in flight.".to_owned())
                } else if !d.dirty() {
                    Some("There is nothing to save.".to_owned())
                } else {
                    None
                }
            }
            Choice::Undo => read_only().or_else(|| {
                (!d.session.can_undo()).then(|| "There is nothing to undo.".to_owned())
            }),
            Choice::Redo => read_only().or_else(|| {
                (!d.session.can_redo()).then(|| "There is nothing to redo.".to_owned())
            }),
            Choice::Find => None,
            Choice::FindNext | Choice::FindPrevious => (!d.find.is_open()
                || d.find.ranges().is_empty())
            .then(|| "There are no matches.".to_owned()),
            Choice::Rename | Choice::Format => language(),
            Choice::Hover | Choice::Complete | Choice::Definition | Choice::References => {
                language()
            }
            Choice::Check => {
                if !self.language {
                    Some("No language service in this workspace.".to_owned())
                } else if d.findings.inflight {
                    Some("A check is already in flight.".to_owned())
                } else if d.session.has_pending() {
                    Some("Wait until the owner has accepted the edits.".to_owned())
                } else if d.session.has_conflict() {
                    Some("Settle the held text first.".to_owned())
                } else if d.sync.desync.is_some() {
                    Some("Waiting for the owner's text.".to_owned())
                } else {
                    None
                }
            }
            Choice::FindReplace => read_only(),
            Choice::Replace | Choice::ReplaceAll => read_only().or_else(|| {
                (!d.find.is_open() || d.find.ranges().is_empty())
                    .then(|| "There are no matches.".to_owned())
            }),
            Choice::Create => None,
            Choice::ApplyPlan => {
                if !self.language {
                    Some("No language service in this workspace.".to_owned())
                } else if d.plan.is_none() {
                    Some("No rename is planned.".to_owned())
                } else {
                    None
                }
            }
            Choice::KeepMine => offer(recovery::Offer::KeepMine).or_else(|| {
                if let Some(r) = read_only() {
                    Some(format!("{r}; sending the text again would be refused."))
                } else {
                    conflict()
                }
            }),
            Choice::TakeTheirs => offer(recovery::Offer::TakeTheirs).or_else(conflict),
            Choice::KeepBoth => offer(recovery::Offer::KeepBoth).or_else(conflict),
            Choice::KeepRecovered => offer(recovery::Offer::Keep),
            Choice::DiscardRecovered => offer(recovery::Offer::Discard),
            Choice::CopyRecovered => d
                .sync
                .restored
                .is_none()
                .then(|| recovery::NOT_RECOVERED.to_owned()),
            Choice::CopyMine => {
                (!d.session.has_conflict() && d.sync.recoverable.is_none() && !unplaced)
                    .then(|| "There is no held text.".to_owned())
            }
            Choice::Resend => d
                .sync
                .unknown
                .is_none()
                .then(|| "No edit is waiting on an unknown answer.".to_owned()),
            Choice::KeepDisk | Choice::KeepAuthority => d
                .sync
                .disk
                .is_none()
                .then(|| "The file on disk has not changed under the editor.".to_owned()),
            Choice::Dismiss => (!(d.find.is_open()
                || d.popup.is_some()
                || d.notice.is_some()
                || d.sync.recoverable.is_some()
                || d.plan.is_some()))
            .then(|| "There is nothing to dismiss.".to_owned()),
            Choice::Retry => Some("Nothing failed.".to_owned()),
            Choice::Close => None,
        }
    }

    // ---- layout -----------------------------------------------------------

    /// How far the edits are from being safe, as the host said it.
    fn kept(&self) -> Option<(recovery::Kept, Option<(&str, &str)>)> {
        let l = self.local.as_ref()?;
        let kept = match l.status {
            LocalStatus::Accepted => recovery::Kept::Accepted,
            LocalStatus::Draft => recovery::Kept::Draft,
            LocalStatus::Checkpointed { .. } => recovery::Kept::Checkpointed,
        };
        let problem = l
            .problem
            .as_ref()
            .map(|p| (p.code.as_str(), p.reason.as_str()));
        Some((kept, problem))
    }

    fn local_flag(&self) -> Option<recovery::LocalFlag> {
        let (kept, problem) = self.kept()?;
        recovery::local_flag(kept, problem.map(|(_, reason)| reason))
    }

    fn local_description(&self) -> Option<String> {
        let (kept, problem) = self.kept()?;
        recovery::local_description(kept, problem)
    }

    /// What the bar over recovered edits says.
    fn recovered_bar<'a>(&self, d: &Doc, r: &'a crate::owner::Restored) -> recovery::Bar<'a> {
        recovery::Bar {
            from: r.moved_from.as_deref(),
            current: d.session.accepted_revision(),
            reason: r.reason.as_deref(),
            text: &r.text,
        }
    }

    fn strip(&self) -> Option<Strip> {
        let d = self.doc()?;
        let text = |t: String, tone, buttons| {
            Some(Strip {
                prompt: Prompt::Text(t, tone),
                buttons,
            })
        };
        if d.rename.is_some() {
            return Some(Strip {
                prompt: Prompt::Rename,
                buttons: vec![],
            });
        }
        if let Some(n) = &self.naming {
            return Some(Strip {
                prompt: Prompt::Name(n.error.clone()),
                buttons: vec![],
            });
        }
        if let Some(r) = &d.sync.restored {
            let bar = self.recovered_bar(d, r);
            let buttons = recovery::offers(bar.placed(), d.sync.read_only.is_some())
                .into_iter()
                .map(Choice::from_offer)
                .collect();
            return text(bar.text(), Tone::Warn, buttons);
        }
        if d.session.has_conflict() || d.sync.held.is_some() {
            let reason = d
                .sync
                .held
                .as_ref()
                .map(|h| h.reason.clone())
                .or_else(|| d.session.conflict().map(|c| c.reason))
                .unwrap_or_default();
            let conflict = d.sync.held.as_ref().is_none_or(|h| h.conflict);
            let mine = d
                .session
                .conflict()
                .map(|c| {
                    c.ranges
                        .iter()
                        .map(|&(a, b)| d.session.rope().slice(a..b).to_string())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            let theirs = match d.sync.held.as_ref().and_then(|h| h.theirs.as_ref()) {
                Some(t) if t.inserted.is_empty() && !t.removed.is_empty() => "(deleted)".to_owned(),
                Some(t) => snip(&t.inserted, 24),
                None if conflict => "(the owner sent no text)".to_owned(),
                None => String::new(),
            };
            let head = if conflict {
                "Both changed this."
            } else {
                "The owner refused the edit."
            };
            let body = if conflict {
                format!(
                    "{head} {reason} Mine: \"{}\" Theirs: \"{theirs}\"",
                    snip(&mine, 24)
                )
            } else {
                format!("{head} {reason} Mine, kept here: \"{}\"", snip(&mine, 24))
            };
            let buttons = if d.sync.read_only.is_some() {
                vec![Choice::TakeTheirs, Choice::CopyMine]
            } else {
                vec![
                    Choice::KeepMine,
                    Choice::TakeTheirs,
                    Choice::KeepBoth,
                    Choice::CopyMine,
                ]
            };
            return text(body, Tone::Error, buttons);
        }
        if let Some(disk) = &d.sync.disk {
            let what = if disk.deleted {
                "The file was deleted on disk."
            } else {
                "The file changed on disk."
            };
            return text(
                format!(
                    "{what} Revision {} differs from the editor's.",
                    disk.revision
                ),
                Tone::Warn,
                vec![Choice::KeepDisk, Choice::KeepAuthority],
            );
        }
        if let Some(u) = &d.sync.unknown {
            return text(
                format!(
                    "Unknown whether the owner took an edit: {} Nothing is sent behind it.",
                    u.reason
                ),
                Tone::Warn,
                vec![Choice::Resend],
            );
        }
        if let Some(p) = &d.plan {
            return text(
                format!("Rename planned against revision {}.", p.revision),
                Tone::Info,
                vec![Choice::ApplyPlan, Choice::Dismiss],
            );
        }
        if d.sync.recoverable.is_some() {
            return text(
                "Their text was taken. Your text is kept.".to_owned(),
                Tone::Info,
                vec![Choice::CopyMine, Choice::Dismiss],
            );
        }
        if let Some(why) = &d.sync.desync {
            return text(why.clone(), Tone::Warn, vec![]);
        }
        None
    }

    pub(super) fn frame(&self, area: Rect) -> Option<Frame> {
        let d = self.doc()?;
        let (mut top, mut bottom) = (area.y, area.y + area.height);
        let plan = (area.height >= 2).then(|| self.status_plan(d, area.width));
        let status = plan.as_ref().map(|_| {
            bottom -= 1;
            Rect::new(area.x, bottom, area.width, 1)
        });
        let notice = plan.as_ref().and_then(|p| {
            let rows = p.notice_rows.min((bottom - top).saturating_sub(1));
            (rows > 0).then(|| {
                bottom -= rows;
                Rect::new(area.x, bottom, area.width, rows)
            })
        });
        let find = (d.find.is_open() && bottom - top >= 2).then(|| {
            let rows = self
                .find_plan(d, area.width)
                .rows
                .min(bottom - top - 1)
                .max(1);
            let r = Rect::new(area.x, top, area.width, rows);
            top += rows;
            r
        });
        let strip = self.strip().and_then(|s| {
            let rows = s.rows(area.width).min((bottom - top).saturating_sub(1));
            (rows > 0).then(|| {
                bottom -= rows;
                Rect::new(area.x, bottom, area.width, rows)
            })
        });
        Some(Frame {
            find,
            text: Rect::new(area.x, top, area.width, bottom - top),
            strip,
            notice,
            status,
        })
    }

    /// The buttons laid out on rows from `origin` down to `bottom`, wrapped
    /// (see [`layout_buttons`]), with why each is unavailable.
    fn buttons_on(
        &self,
        origin: Rect,
        bottom: u16,
        buttons: &[Choice],
    ) -> Vec<(Choice, Rect, Option<String>)> {
        let mut out = Vec::new();
        for (i, row) in layout_buttons(buttons, origin.width).iter().enumerate() {
            let y = origin.y + i as u16;
            if y >= bottom {
                break;
            }
            let mut x = origin.x;
            for (b, text) in row {
                let w = text.width() as u16;
                out.push((*b, Rect::new(x, y, w, 1), self.unavailable(*b)));
                x += w + 1;
            }
        }
        out
    }

    /// The labels the buttons are drawn with, by choice.
    fn button_labels(buttons: &[Choice], width: u16) -> Vec<(Choice, String)> {
        layout_buttons(buttons, width)
            .into_iter()
            .flatten()
            .collect()
    }

    fn strip_buttons(&self, rect: Rect) -> Vec<(Choice, Rect, Option<String>)> {
        let Some(strip) = self.strip() else {
            return vec![];
        };
        if strip.buttons.is_empty() {
            return vec![];
        }
        let n = layout_buttons(&strip.buttons, rect.width).len() as u16;
        let top = rect.y + rect.height.saturating_sub(n);
        self.buttons_on(
            Rect::new(rect.x, top, rect.width, 1),
            rect.y + rect.height,
            &strip.buttons,
        )
    }

    pub(super) fn strip_button_at(&self, frame: &Frame, x: i32, y: i32) -> Option<Choice> {
        let strip = frame.strip?;
        self.strip_buttons(strip)
            .into_iter()
            .find(|(_, r, _)| {
                x >= i32::from(r.x) && x < i32::from(r.x + r.width) && y == i32::from(r.y)
            })
            .map(|(c, _, _)| c)
    }

    fn message_buttons(&self) -> Vec<Choice> {
        match &self.phase {
            Phase::Failed(p) if p.can_retry => vec![Choice::Retry, Choice::Close],
            _ if self.naming_idle() => vec![Choice::Create, Choice::Close],
            _ => vec![Choice::Close],
        }
    }

    /// Where the buttons start: under the wrapped lines of the message.
    fn message_row(&self, area: Rect) -> Rect {
        if self.naming_idle() {
            let y = self.naming_rows(area).2;
            return Rect::new(
                area.x,
                y.min(area.y + area.height.saturating_sub(1)),
                area.width,
                1,
            );
        }
        let rows: u16 = self
            .message_lines()
            .iter()
            .map(|(t, _)| wrap(t, area.width).len().max(1) as u16)
            .sum();
        Rect::new(
            area.x,
            area.y + rows.min(area.height.saturating_sub(1)),
            area.width,
            1,
        )
    }

    fn message_laid_out(&self, area: Rect) -> Vec<(Choice, Rect, Option<String>)> {
        self.buttons_on(
            self.message_row(area),
            area.y + area.height,
            &self.message_buttons(),
        )
    }

    pub(super) fn message_button_at(&self, area: Rect, x: i32, y: i32) -> Option<Choice> {
        self.message_laid_out(area)
            .into_iter()
            .find(|(_, r, _)| {
                x >= i32::from(r.x) && x < i32::from(r.x + r.width) && y == i32::from(r.y)
            })
            .map(|(c, _, _)| c)
    }

    // ---- the status line --------------------------------------------------

    fn find_plan(&self, d: &Doc, width: u16) -> FindPlan {
        let w = usize::from(width);
        let prefix = if d.find.case_sensitive() {
            "Find (case) "
        } else {
            "Find "
        };
        let summary = d.find.summary(&d.session);
        let full = if summary.is_empty() {
            "Alt+C case".to_owned()
        } else {
            format!("{summary}  Alt+C case")
        };
        let tail = [full, summary, String::new()]
            .into_iter()
            .find(|t| {
                let gap = usize::from(!t.is_empty());
                w.saturating_sub(prefix.width() + t.width() + gap) >= FIELD_ROOM
            })
            .unwrap_or_default();
        let mut rows = 1;
        let mut inline_replace = true;
        if d.find.is_replacing() {
            rows += 1;
            let tail = format!("{}  {}", label(Choice::Replace), label(Choice::ReplaceAll));
            inline_replace = w.saturating_sub("Replace ".width() + tail.width() + 1) >= FIELD_ROOM;
            if !inline_replace {
                rows += layout_buttons(&[Choice::Replace, Choice::ReplaceAll], width).len() as u16;
            }
        }
        FindPlan {
            rows,
            tail,
            inline_replace,
        }
    }

    /// The replace buttons of the find bar in `rect`, where they are drawn.
    fn find_buttons(&self, d: &Doc, rect: Rect) -> Vec<(Choice, Rect, Option<String>)> {
        if !d.find.is_replacing() || rect.height < 2 {
            return vec![];
        }
        let buttons = [Choice::Replace, Choice::ReplaceAll];
        if self.find_plan(d, rect.width).inline_replace {
            let mut x = rect.x + rect.width
                - (label(Choice::Replace).width() + 2 + label(Choice::ReplaceAll).width()) as u16;
            buttons
                .iter()
                .map(|&b| {
                    let w = label(b).width() as u16;
                    let r = Rect::new(x, rect.y + 1, w, 1);
                    x += w + 2;
                    (b, r, self.unavailable(b))
                })
                .collect()
        } else {
            self.buttons_on(
                Rect::new(rect.x, rect.y + 2, rect.width, 1),
                rect.y + rect.height,
                &buttons,
            )
        }
    }

    pub(super) fn find_button_at(&self, frame: &Frame, x: i32, y: i32) -> Option<Choice> {
        let (d, rect) = (self.doc()?, frame.find?);
        self.find_buttons(d, rect)
            .into_iter()
            .find(|(_, r, _)| {
                x >= i32::from(r.x) && x < i32::from(r.x + r.width) && y == i32::from(r.y)
            })
            .map(|(c, _, _)| c)
    }

    /// What is true of the document, as flags: the long form and the short
    /// one a narrow line falls back to, and whether any asks for attention.
    fn status_flags(&self, d: &Doc) -> (Vec<Flag>, bool) {
        let mut flags: Vec<Flag> = vec![];
        let mut attention = false;
        let mut flag = |long: String, short: &str, warn: bool, rank: Rank| {
            flags.push(Flag {
                long,
                short: short.to_owned(),
                rank,
            });
            attention |= warn;
        };
        if d.dirty() {
            flag("modified".to_owned(), "modified", false, Rank::Work);
        }
        if let Some(l) = self.local_flag() {
            flag(l.long, l.short, l.attention, Rank::Work);
        }
        if let Some(r) = &d.sync.read_only {
            flag(format!("read-only: {r}"), "read-only", true, Rank::Work);
        }
        if d.sync.save.inflight.is_some() {
            flag("saving".to_owned(), "saving", false, Rank::Progress);
        }
        if d.sync.save.unknown.is_some() {
            flag("save unknown".to_owned(), "save unknown", true, Rank::Work);
        }
        if d.sync.unknown.is_some() {
            flag("edit unknown".to_owned(), "edit unknown", true, Rank::Work);
        } else if d.sync.inflight.is_some() {
            flag("sending".to_owned(), "sending", false, Rank::Progress);
        }
        if d.sync.desync.is_some() {
            flag("out of sync".to_owned(), "out of sync", true, Rank::Work);
        }
        if d.sync.save.wanted {
            flag(
                "save waits for edits".to_owned(),
                "save waits",
                false,
                Rank::Progress,
            );
        }
        if let Some(b) = d.busy {
            flag(b.to_owned(), b, false, Rank::Progress);
        }
        if d.sync.restored.is_some() {
            flag(
                recovery::WAITS_FLAG.0.to_owned(),
                recovery::WAITS_FLAG.1,
                true,
                Rank::Work,
            );
        }
        if let Some(p) = &d.findings.problem {
            flag(
                format!("no findings: {p}"),
                "no findings",
                false,
                Rank::Progress,
            );
        }
        match self.connection {
            None | Some(ConnectionState::Open) => {}
            Some(state) => {
                let word = format!("{state:?}").to_lowercase();
                flag(word.clone(), &word, true, Rank::State);
            }
        }
        (flags, attention)
    }

    /// The left side in full: the path and the flags.
    fn status_left(&self, d: &Doc) -> (String, bool) {
        let (flags, attention) = self.status_flags(d);
        let mut s = self.path.clone();
        for f in &flags {
            s.push_str(&format!(" [{}]", f.long));
        }
        (s, attention)
    }

    /// Fit the status line to `width`. The order in which things give way:
    /// 1. the notice (or the finding on the caret line) moves to its own
    ///    wrapped rows above the line, if it does not fit beside the rest;
    /// 2. the right side shortens: first without the line ending and the
    ///    revision, then without the selection count and "(graphemes)", down
    ///    to `Ln n, Col n`;
    /// 3. the flags say less (`read-only: why` becomes `read-only`);
    /// 4. the path loses its leading directories, then the middle of the
    ///    file name, down to one cell. The position and the flags stay.
    fn status_plan(&self, d: &Doc, width: u16) -> StatusPlan {
        let w = usize::from(width);
        let (flags, attention) = self.status_flags(d);
        let join = |kept: &[&Flag], short: bool| -> String {
            kept.iter()
                .map(|f| format!(" [{}]", if short { &f.short } else { &f.long }))
                .collect()
        };
        let name_w = self
            .path
            .rsplit('/')
            .next()
            .map_or(0, UnicodeWidthStr::width);
        let rights = self.status_right(d);
        let fits = |r: &str, f: &str, path: usize| {
            r.width() + usize::from(!r.is_empty()) + f.width() + path <= w
        };
        // Flags in the order they give way: the long forms, the short forms, then
        // the lower ranks one rank at a time, the file name kept whole.
        let mut chosen = None;
        'pick: for (kept, short) in [
            (rank_at_least(&flags, Rank::Progress), false),
            (rank_at_least(&flags, Rank::Progress), true),
            (rank_at_least(&flags, Rank::State), true),
            (rank_at_least(&flags, Rank::Work), true),
        ] {
            let f = join(&kept, short);
            for r in &rights {
                if fits(r, &f, name_w) {
                    chosen = Some((r.clone(), f.clone(), String::new()));
                    break 'pick;
                }
            }
        }
        // Nothing fits beside the whole name: the path gives way, and only the
        // flags that warn of unsaved or recovered work are left. Those that do
        // not fit even then, whole, move to the rows above the line; none is cut.
        let (right, flag_text, overflow) = chosen.unwrap_or_else(|| {
            let work = rank_at_least(&flags, Rank::Work);
            let short = join(&work, true);
            for r in &rights {
                if fits(r, &short, 1) {
                    return (r.clone(), short, String::new());
                }
            }
            let right = rights[rights.len() - 1].clone();
            let room = w.saturating_sub(right.width() + usize::from(!right.is_empty()) + 1);
            let (mut line, mut rest) = (String::new(), String::new());
            for f in &work {
                let word = format!(" [{}]", f.short);
                if rest.is_empty() && line.width() + word.width() <= room {
                    line.push_str(&word);
                } else {
                    // A flag is one word to the wrap: it never breaks inside the brackets.
                    let whole = f.short.replace(' ', "\u{a0}");
                    rest.push_str(&format!(
                        "{}[{whole}]",
                        if rest.is_empty() { "" } else { " " }
                    ));
                }
            }
            (right, line, rest)
        });
        let gap = usize::from(!right.is_empty());
        let path_room = w.saturating_sub(right.width() + gap + flag_text.width());
        let path = shorten_path(&self.path, path_room);
        let left = format!("{path}{flag_text}");
        let finding = d.finding_here().map(|f| {
            let tone = match f.severity {
                Severity::Error => Tone::Error,
                Severity::Warning => Tone::Warn,
                Severity::Info | Severity::Hint => Tone::Info,
            };
            (format!("{}: {}", word(f.severity), f.message), tone)
        });
        // A failed keep keeps its reason in view when the flag had to say less.
        let not_kept = self
            .local
            .as_ref()
            .and_then(|l| l.problem.as_ref())
            .filter(|p| !left.contains(&p.reason))
            .map(|p| (recovery::local_notice(&p.reason), Tone::Warn));
        let shown = match (&d.notice, finding) {
            (Some(n), _) => Some((n.text.clone(), n.tone)),
            (None, finding) => finding.or(not_kept),
        };
        // The flags that did not fit on the line come first among the rows above it.
        let shown = if overflow.is_empty() {
            shown
        } else {
            Some(match shown {
                Some((t, tone)) => (format!("{overflow}\n{t}"), tone),
                None => (overflow.clone(), Tone::Warn),
            })
        };
        let inline_room = w.saturating_sub(right.width() + gap + left.width() + 2);
        let (notice_inline, notice_rows) = match &shown {
            Some((t, _)) if overflow.is_empty() && t.width() <= inline_room => (true, 0),
            Some((t, _)) => (false, wrap(t, width).len().max(1) as u16),
            None => (false, 0),
        };
        StatusPlan {
            left,
            right,
            attention,
            notice: shown,
            notice_inline,
            notice_rows,
        }
    }

    /// The right side, longest form first: line and column in grapheme
    /// clusters (what an arrow key counts), the selection, the line ending and
    /// the accepted revision.
    fn status_right(&self, d: &Doc) -> Vec<String> {
        let at = d.view.position(&d.session);
        let place = format!("Ln {}, Col {} (graphemes)", at.line, at.column);
        let selected = d.session.selection().map_or(0, |(a, b)| {
            let c = d.session.coords();
            c.grapheme_index(b) - c.grapheme_index(a)
        });
        let sel = if selected > 0 {
            format!(" | {selected} selected")
        } else {
            String::new()
        };
        let rope = d.session.rope();
        let first = rope.line(0);
        let n = first.len_chars();
        let eol = if n >= 2 && first.char(n - 2) == '\r' && first.char(n - 1) == '\n' {
            "CRLF"
        } else {
            "LF"
        };
        vec![
            format!("{place}{sel} | {eol} | r{}", d.session.accepted_revision()),
            format!("{place}{sel}"),
            format!("Ln {}, Col {}", at.line, at.column),
        ]
    }

    // ---- drawing ----------------------------------------------------------

    pub(super) fn draw(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        buf.set_style(area, cx.theme.bg);
        let Some(frame) = self.frame(area) else {
            self.draw_message(area, buf, cx);
            return;
        };
        let Phase::Ready(d) = &self.phase else { return };
        let styles = self.styles(cx);
        let tone = |t: Tone| match t {
            Tone::Info => cx.theme.text,
            Tone::Warn => cx.theme.warning,
            Tone::Error => cx.theme.error,
        };

        // The text.
        let marks = d.marks(&styles);
        let gutter = d.gutter(&styles);
        let tokens = d.tokens.marks(&d.session, d.version, &styles);
        let paint = Paint {
            focused: cx.focused && !d.in_find && d.rename.is_none() && self.naming.is_none(),
            matches: if d.find.is_open() {
                d.find.ranges()
            } else {
                &[]
            },
            current: d.find.current(&d.session),
            tokens: &tokens,
            marks: &marks,
            gutter: &gutter,
            preedit: d.preedit.as_deref(),
            ..Paint::new(&styles)
        };
        let caret = d.view.draw(&d.session, frame.text, buf, &paint);
        if let Some(popup) = &d.popup {
            draw_popup(popup, caret, frame.text, buf, &styles);
        }

        // The find bar.
        if let Some(rect) = frame.find {
            buf.set_style(rect, cx.theme.line);
            let plan = self.find_plan(d, rect.width);
            let row = Rect::new(rect.x, rect.y, rect.width, 1);
            let prefix = if d.find.case_sensitive() {
                "Find (case) "
            } else {
                "Find "
            };
            buf.set_stringn(row.x, row.y, prefix, usize::from(row.width), cx.theme.muted);
            let tail_w = plan.tail.width() as u16;
            let gap = u16::from(tail_w > 0);
            let x0 = row.x + prefix.width() as u16;
            let room = row
                .width
                .saturating_sub(prefix.width() as u16 + tail_w + gap);
            let value = d.find.field.value();
            let scroll = d.find.field.scroll(usize::from(room.max(1)));
            let shown = skip_cells(value, scroll);
            buf.set_stringn(x0, row.y, &shown, usize::from(room), cx.theme.text);
            if d.in_find && !d.in_replace && cx.focused && room > 0 {
                let at = d
                    .find
                    .field
                    .cursor()
                    .min(usize::from(room.saturating_sub(1)));
                buf.set_style(Rect::new(x0 + at as u16, row.y, 1, 1), styles.caret);
            }
            if tail_w > 0 && row.width > tail_w {
                buf.set_stringn(
                    row.x + row.width - tail_w,
                    row.y,
                    &plan.tail,
                    usize::from(tail_w),
                    cx.theme.muted,
                );
            }
            if d.find.is_replacing() && rect.height >= 2 {
                let row = Rect::new(rect.x, rect.y + 1, rect.width, 1);
                let prefix = "Replace ";
                buf.set_stringn(row.x, row.y, prefix, usize::from(row.width), cx.theme.muted);
                let tail_w = if plan.inline_replace {
                    (label(Choice::Replace).width() + 2 + label(Choice::ReplaceAll).width()) as u16
                } else {
                    0
                };
                let gap = u16::from(tail_w > 0);
                let x0 = row.x + prefix.width() as u16;
                let room = row
                    .width
                    .saturating_sub(prefix.width() as u16 + tail_w + gap);
                let field = &d.find.replacement;
                let shown = skip_cells(field.value(), field.scroll(usize::from(room.max(1))));
                buf.set_stringn(x0, row.y, &shown, usize::from(room), cx.theme.text);
                if d.in_find && d.in_replace && cx.focused && room > 0 {
                    let at = field.cursor().min(usize::from(room.saturating_sub(1)));
                    buf.set_style(Rect::new(x0 + at as u16, row.y, 1, 1), styles.caret);
                }
                let labels =
                    Self::button_labels(&[Choice::Replace, Choice::ReplaceAll], rect.width);
                for (choice, r, why) in self.find_buttons(d, rect) {
                    let style = if why.is_none() {
                        cx.theme.selected
                    } else {
                        cx.theme.muted
                    };
                    let text = labels
                        .iter()
                        .find(|(c, _)| *c == choice)
                        .map_or_else(|| label(choice), |(_, t)| t.clone());
                    buf.set_stringn(r.x, r.y, text, usize::from(r.width), style);
                }
            }
        }

        // The strip.
        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            let button_rows = layout_buttons(&strip.buttons, rect.width).len() as u16;
            let text_rows = rect.height.saturating_sub(button_rows);
            match &strip.prompt {
                Prompt::Text(t, t_tone) => {
                    for (i, line) in wrap(t, rect.width)
                        .iter()
                        .take(usize::from(text_rows))
                        .enumerate()
                    {
                        buf.set_stringn(
                            rect.x,
                            rect.y + i as u16,
                            line,
                            usize::from(rect.width),
                            tone(*t_tone),
                        );
                    }
                }
                Prompt::Name(error) => {
                    if let Some(n) = &self.naming {
                        draw_name(n, error.as_deref(), rect, buf, cx, &styles);
                    }
                }
                Prompt::Rename => {
                    let field = d.rename.as_ref();
                    let prefix = "Rename to ";
                    buf.set_stringn(
                        rect.x,
                        rect.y,
                        prefix,
                        usize::from(rect.width),
                        cx.theme.muted,
                    );
                    if let Some(field) = field {
                        let x0 = rect.x + prefix.width() as u16;
                        let room = rect.width.saturating_sub(prefix.width() as u16);
                        let shown =
                            skip_cells(field.value(), field.scroll(usize::from(room.max(1))));
                        buf.set_stringn(x0, rect.y, &shown, usize::from(room), cx.theme.text);
                        if cx.focused && room > 0 {
                            let at = field.cursor().min(usize::from(room - 1));
                            buf.set_style(Rect::new(x0 + at as u16, rect.y, 1, 1), styles.caret);
                        }
                    }
                }
            }
            let labels = Self::button_labels(&strip.buttons, rect.width);
            for (choice, r, why) in self.strip_buttons(rect) {
                let style = if why.is_none() {
                    cx.theme.selected
                } else {
                    cx.theme.muted
                };
                let text = labels
                    .iter()
                    .find(|(c, _)| *c == choice)
                    .map_or_else(|| label(choice), |(_, t)| t.clone());
                buf.set_stringn(r.x, r.y, text, usize::from(r.width), style);
            }
        }

        // The status line, and a notice that did not fit on it.
        if let Some(row) = frame.status {
            buf.set_style(row, cx.theme.line);
            let plan = self.status_plan(d, row.width);
            let base = if plan.attention {
                cx.theme.warning
            } else {
                cx.theme.muted
            };
            let right_w = plan.right.width() as u16;
            let (x, _) = buf.set_stringn(row.x, row.y, &plan.left, usize::from(row.width), base);
            if let Some((text, t)) = &plan.notice {
                if plan.notice_inline {
                    buf.set_stringn(x + 2, row.y, text, usize::from(row.width), tone(*t));
                } else if let Some(rect) = frame.notice {
                    buf.set_style(rect, cx.theme.line);
                    for (i, line) in wrap(text, rect.width)
                        .iter()
                        .take(usize::from(rect.height))
                        .enumerate()
                    {
                        buf.set_stringn(
                            rect.x,
                            rect.y + i as u16,
                            line,
                            usize::from(rect.width),
                            tone(*t),
                        );
                    }
                }
            }
            if right_w > 0 {
                buf.set_stringn(
                    row.x + row.width - right_w,
                    row.y,
                    &plan.right,
                    usize::from(right_w),
                    cx.theme.muted,
                );
            }
        }
    }

    /// The prompt of an editor with no file: the name, the owner's word on the
    /// last one, and the choices.
    fn draw_naming_screen(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        let Some(n) = &self.naming else { return };
        let styles = self.styles(cx);
        let bottom = area.y + area.height;
        let (name_y, error_y, _) = self.naming_rows(area);
        buf.set_stringn(
            area.x,
            area.y,
            "New page",
            usize::from(area.width),
            cx.theme.muted,
        );
        for (i, line) in wrap(NAMING_HELP, area.width).iter().enumerate() {
            let y = area.y + 1 + i as u16;
            if y < bottom {
                buf.set_stringn(area.x, y, line, usize::from(area.width), cx.theme.text);
            }
        }
        if name_y < bottom {
            draw_name(
                n,
                None,
                Rect::new(area.x, name_y, area.width, 1),
                buf,
                cx,
                &styles,
            );
        }
        if let Some(error) = &n.error {
            for (i, line) in wrap(error, area.width).iter().enumerate() {
                let y = error_y + i as u16;
                if y < bottom {
                    buf.set_stringn(area.x, y, line, usize::from(area.width), cx.theme.error);
                }
            }
        }
        let labels = Self::button_labels(&self.message_buttons(), area.width);
        for (choice, r, why) in self.message_laid_out(area) {
            let style = if why.is_none() {
                cx.theme.selected
            } else {
                cx.theme.muted
            };
            let text = labels
                .iter()
                .find(|(c, _)| *c == choice)
                .map_or_else(|| label(choice), |(_, t)| t.clone());
            buf.set_stringn(r.x, r.y, text, usize::from(r.width), style);
        }
    }

    /// The rows of the naming screen: the field, the owner's word on the last
    /// name, and where the buttons start. The help text wraps, so they move.
    fn naming_rows(&self, area: Rect) -> (u16, u16, u16) {
        let help = wrap(NAMING_HELP, area.width).len() as u16;
        let name_y = area.y + 1 + help + 1;
        let error_rows = self
            .naming
            .as_ref()
            .and_then(|n| n.error.as_ref())
            .map_or(1, |e| wrap(e, area.width).len() as u16);
        (name_y, name_y + 1, name_y + 1 + error_rows)
    }

    fn message_lines(&self) -> Vec<(String, Tone)> {
        let path = (self.path.clone(), Tone::Info);
        if self.naming_idle() {
            let mut lines = vec![
                ("New page".to_owned(), Tone::Info),
                (NAMING_HELP.to_owned(), Tone::Info),
            ];
            if let Some(e) = self.naming.as_ref().and_then(|n| n.error.clone()) {
                lines.push((e, Tone::Error));
            }
            return lines;
        }
        match &self.phase {
            Phase::Waiting if self.path.is_empty() => vec![
                ("No file".to_owned(), Tone::Info),
                (
                    "This editor has not been given a file to show.".to_owned(),
                    Tone::Warn,
                ),
            ],
            Phase::Waiting if !self.documents => vec![
                path,
                (
                    "The document service is not available in this workspace.".to_owned(),
                    Tone::Warn,
                ),
            ],
            Phase::Waiting => vec![path, ("Waiting for the workspace.".to_owned(), Tone::Info)],
            Phase::Opening => vec![path, ("Opening the document...".to_owned(), Tone::Info)],
            Phase::Failed(p) => {
                let mut v = vec![
                    path,
                    (
                        p.headline.clone(),
                        if p.unknown { Tone::Warn } else { Tone::Error },
                    ),
                    (p.reason.clone(), Tone::Info),
                ];
                if let Some(code) = &p.code {
                    v.push((format!("({code})"), Tone::Info));
                }
                v
            }
            Phase::Ready(_) => vec![],
        }
    }

    fn draw_message(&self, area: Rect, buf: &mut Buffer, cx: &ViewCtx) {
        if area.height == 0 || area.width == 0 {
            return;
        }
        let tone = |t: Tone| match t {
            Tone::Info => cx.theme.text,
            Tone::Warn => cx.theme.warning,
            Tone::Error => cx.theme.error,
        };
        if self.naming_idle() {
            self.draw_naming_screen(area, buf, cx);
            return;
        }
        // Each line wrapped under the one before; the first is the path, dim,
        // and the last of a failure is the owner's code, dim too.
        let lines = self.message_lines();
        let count = lines.len();
        let mut y = area.y;
        for (i, (text, t)) in lines.iter().enumerate() {
            let dim = i == 0 || (i + 1 == count && text.starts_with('(') && count > 3);
            let style: Style = if dim { cx.theme.muted } else { tone(*t) };
            for line in wrap(text, area.width) {
                if y >= area.y + area.height {
                    break;
                }
                buf.set_stringn(area.x, y, &line, usize::from(area.width), style);
                y += 1;
            }
        }
        let labels = Self::button_labels(&self.message_buttons(), area.width);
        for (choice, r, why) in self.message_laid_out(area) {
            let style = if why.is_none() {
                cx.theme.selected
            } else {
                cx.theme.muted
            };
            let text = labels
                .iter()
                .find(|(c, _)| *c == choice)
                .map_or_else(|| label(choice), |(_, t)| t.clone());
            buf.set_stringn(r.x, r.y, text, usize::from(r.width), style);
        }
    }

    // ---- semantics --------------------------------------------------------

    fn action(&self, choice: Choice) -> NodeAction {
        let why = self.unavailable(choice);
        NodeAction {
            id: choice.action_id(),
            enabled: why.is_none(),
            reason: why,
        }
    }

    pub(super) fn nodes(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let Some(frame) = self.frame(area) else {
            return self.message_nodes(area, cx);
        };
        let Phase::Ready(d) = &self.phase else {
            return vec![];
        };
        let at = d.view.position(&d.session);
        let mut root = Node::new("text", Role::TextBox, &self.path, frame.text);
        root.binding = self.resource();
        root.revision = Some(CoreRevision::Seq(d.session.accepted_revision()));
        root.state.focused = cx.focused && !d.in_find && d.rename.is_none();
        root.state.busy =
            d.sync.inflight.is_some() || d.sync.save.inflight.is_some() || d.busy.is_some();
        let selected = d.session.selection().map_or(0, |(a, b)| {
            let c = d.session.coords();
            c.grapheme_index(b) - c.grapheme_index(a)
        });
        let mut words = vec![if d.dirty() { "modified" } else { "saved" }.to_owned()];
        if let Some(r) = &d.sync.read_only {
            words.push(format!("read-only: {r}"));
        }
        words.push(format!(
            "line {}, column {} in graphemes ({} in UTF-16 units)",
            at.line, at.column, at.utf16
        ));
        if selected > 0 {
            words.push(format!("{selected} graphemes selected"));
        }
        if let Some(r) = &d.sync.restored {
            words.push(self.recovered_bar(d, r).description());
        }
        if let Some(l) = self.local_description() {
            words.push(l);
        }
        if d.find.is_open() {
            words.push(format!("find: {}", d.find.summary(&d.session)));
        }
        let found = d.findings();
        if !found.is_empty() {
            let count = |s: Severity| found.iter().filter(|f| f.severity == s).count();
            words.push(format!(
                "{} findings ({} errors, {} warnings)",
                found.len(),
                count(Severity::Error),
                count(Severity::Warning)
            ));
        }
        if let Some(f) = d.finding_here() {
            words.push(format!("{} on this line: {}", word(f.severity), f.message));
        }
        root.state.description = Some(words.join("; "));
        root.actions = [
            Choice::Save,
            Choice::Undo,
            Choice::Redo,
            Choice::Find,
            Choice::FindNext,
            Choice::FindPrevious,
            Choice::FindReplace,
            Choice::KeepRecovered,
            Choice::DiscardRecovered,
            Choice::Rename,
            Choice::Format,
            Choice::ApplyPlan,
            Choice::Hover,
            Choice::Complete,
            Choice::Definition,
            Choice::References,
            Choice::Check,
        ]
        .into_iter()
        .map(|c| self.action(c))
        .collect();
        root.shortcut = Some("Ctrl+S".to_owned());

        let mut out = vec![];
        let mut children = vec![];

        if let Some(row) = frame.status {
            let (left, _) = self.status_left(d);
            let right = self.status_right(d).remove(0);
            let mut n = Node::new("status", Role::Status, &format!("{left}  {right}"), row);
            n.state.description = d.notice.as_ref().map(|n| n.text.clone());
            children.push(n.id.clone());
            out.push(n);
        }
        if let Some(flag) = self.local_flag() {
            let mut n = Node::new(
                recovery::LOCAL_NODE,
                Role::Status,
                &flag.long,
                frame.status.unwrap_or(area),
            );
            n.binding = self.resource();
            n.state.description = self.local_description();
            children.push(n.id.clone());
            out.push(n);
        }
        if let (Some(rect), Some(plan)) = (
            frame.notice,
            frame.status.map(|r| self.status_plan(d, r.width)),
        ) && let Some((text, _)) = plan.notice
        {
            let n = Node::new("notice", Role::Status, &text, rect);
            children.push(n.id.clone());
            out.push(n);
        }
        if let Some(c) = d.view.caret_cell(&d.session, frame.text) {
            let mut n = Node::new(
                "caret",
                Role::Group,
                "Caret",
                Rect::new(c.x, c.y, c.width, 1),
            );
            n.state.description = Some(format!(
                "line {}, column {} (graphemes), display cell {}",
                at.line, at.column, at.cell
            ));
            children.push(n.id.clone());
            out.push(n);
        }
        if let Some(row) = frame.find {
            let mut group = Node::new("find", Role::Group, "Find in file", row);
            group.state.description = Some(format!(
                "{}{}",
                d.find.summary(&d.session),
                if d.find.case_sensitive() {
                    "; case sensitive"
                } else {
                    "; ignoring case"
                }
            ));
            group.actions = [
                Choice::FindNext,
                Choice::FindPrevious,
                Choice::Replace,
                Choice::ReplaceAll,
            ]
            .into_iter()
            .map(|c| self.action(c))
            .collect();
            let row = Rect::new(row.x, row.y, row.width, 1);
            let mut field = Node::new("find-query", Role::TextBox, "Find", row);
            field.state.focused = d.in_find && !d.in_replace && cx.focused;
            field.state.description = Some(d.find.field.value().to_owned());
            group.children = vec![field.id.clone()];
            for (choice, r, why) in self.find_buttons(d, frame.find.unwrap_or(row)) {
                let a = self.action(choice);
                let mut b = Node::new(
                    &format!("find:{}", choice.id()),
                    Role::Button,
                    choice.descriptor().title,
                    r,
                );
                b.state.disabled = why.is_some();
                b.state.description = a.reason.clone();
                b.shortcut = Some(choice.descriptor().chord.to_owned()).filter(|c| !c.is_empty());
                b.actions = vec![a];
                group.children.push(b.id.clone());
                out.push(b);
            }
            if d.find.is_replacing() {
                let below = Rect::new(row.x, row.y + 1, row.width, 1);
                let mut with = Node::new("find-replacement", Role::TextBox, "Replace with", below);
                with.state.focused = d.in_find && d.in_replace && cx.focused;
                with.state.description = Some(d.find.replacement.value().to_owned());
                group.children.push(with.id.clone());
                out.push(with);
            }
            children.push(group.id.clone());
            out.push(group);
            out.push(field);
        }
        if let (Some(rect), Some(strip)) = (frame.strip, self.strip()) {
            match &strip.prompt {
                Prompt::Name(error) => {
                    let mut n = Node::new("naming", Role::TextBox, "Name of the new page", rect);
                    n.state.focused = cx.focused;
                    let value = self.naming.as_ref().map(|n| n.field.value().to_owned());
                    n.state.description = match (value, error) {
                        (Some(v), Some(e)) => Some(format!("{v}; {e}")),
                        (Some(v), None) => Some(v),
                        (None, e) => e.clone(),
                    };
                    n.actions = vec![self.action(Choice::Create)];
                    children.push(n.id.clone());
                    out.push(n);
                }
                Prompt::Rename => {
                    let mut n = Node::new("rename", Role::TextBox, "Rename symbol", rect);
                    n.state.focused = cx.focused;
                    n.state.description = d.rename.as_ref().map(|f| f.value().to_owned());
                    children.push(n.id.clone());
                    out.push(n);
                }
                Prompt::Text(text, _) => {
                    let mut alert = Node::new(recovery::BAR_NODE, Role::Alert, text, rect);
                    alert.binding = self.resource();
                    alert.state.description = d
                        .sync
                        .restored
                        .as_ref()
                        .map(|r| self.recovered_bar(d, r).description());
                    let buttons = strip.buttons.clone();
                    let mut kids = vec![];
                    for choice in &buttons {
                        let a = self.action(*choice);
                        alert.actions.push(a.clone());
                        let shown = self
                            .strip_buttons(rect)
                            .into_iter()
                            .find(|(c, _, _)| c == choice)
                            .map(|(_, r, _)| r)
                            .unwrap_or_else(|| Rect::new(rect.x, rect.y, 0, 0));
                        let mut b = Node::new(
                            &format!("strip:{}", choice.id()),
                            Role::Button,
                            choice.descriptor().title,
                            shown,
                        );
                        b.state.disabled = !a.enabled;
                        b.state.description = a.reason.clone();
                        b.shortcut =
                            Some(choice.descriptor().chord.to_owned()).filter(|c| !c.is_empty());
                        b.actions = vec![a];
                        kids.push(b);
                    }
                    alert.children = kids.iter().map(|k| k.id.clone()).collect();
                    children.push(alert.id.clone());
                    out.push(alert);
                    out.extend(kids);
                }
            }
        }
        if let Some(popup) = &d.popup {
            let rows = popup.rows();
            let mut list = Node::new("popup", Role::Menu, popup.title(), frame.text);
            list.binding = self.resource();
            let mut kids = vec![];
            for (i, text) in rows.iter().enumerate().take(100) {
                let mut item = Node::new(
                    &format!("popup:{i}"),
                    if popup.selected().is_some() {
                        Role::MenuItem
                    } else {
                        Role::Document
                    },
                    text,
                    frame.text,
                );
                item.state.selected = popup.selected() == Some(i);
                kids.push(item);
            }
            list.children = kids.iter().map(|k| k.id.clone()).collect();
            children.push(list.id.clone());
            out.push(list);
            out.extend(kids);
        }
        root.children = children;
        let mut all = vec![root];
        all.extend(out);
        all
    }

    fn message_nodes(&self, area: Rect, cx: &ViewCtx) -> Vec<Node> {
        let lines = self.message_lines();
        let name = lines
            .iter()
            .map(|(t, _)| t.as_str())
            .collect::<Vec<_>>()
            .join(". ");
        let role = if matches!(self.phase, Phase::Failed(_)) {
            Role::Alert
        } else {
            Role::Status
        };
        let mut root = Node::new("state", role, &name, area);
        root.binding = self.resource();
        root.state.busy = matches!(self.phase, Phase::Opening);
        root.state.focused = cx.focused;
        let mut kids = vec![];
        if self.naming_idle()
            && let Some(n) = &self.naming
        {
            let mut name = Node::new("name", Role::TextBox, "Name of the new page", area);
            name.state.focused = cx.focused;
            name.state.description = Some(n.field.value().to_owned());
            name.actions = vec![self.action(Choice::Create)];
            kids.push(name);
        }
        for choice in self.message_buttons() {
            let a = self.action(choice);
            let shown = self
                .message_laid_out(area)
                .into_iter()
                .find(|(c, _, _)| *c == choice)
                .map(|(_, r, _)| r)
                .unwrap_or_else(|| Rect::new(area.x, area.y, 0, 0));
            let mut b = Node::new(
                &format!("state:{}", choice.id()),
                Role::Button,
                choice.descriptor().title,
                shown,
            );
            b.state.disabled = !a.enabled;
            b.state.description = a.reason.clone();
            root.actions.push(a.clone());
            b.actions = vec![a];
            kids.push(b);
        }
        root.children = kids.iter().map(|k| NodeId::new(k.id.as_str())).collect();
        let mut out = vec![root];
        out.extend(kids);
        out
    }
}

/// The text after its first `skip` display cells.
fn skip_cells(text: &str, skip: usize) -> String {
    let mut cells = 0;
    let mut out = String::new();
    for c in text.chars() {
        if cells >= skip {
            out.push(c);
        }
        cells += c.width().unwrap_or(0);
    }
    out
}

/// The name prompt of a new page on one row, and the owner's word on the last
/// name under it when there is a row for it.
fn draw_name(
    n: &super::create::Naming,
    error: Option<&str>,
    rect: Rect,
    buf: &mut Buffer,
    cx: &ViewCtx,
    styles: &EditorStyles,
) {
    let prefix = "New page name ";
    buf.set_stringn(
        rect.x,
        rect.y,
        prefix,
        usize::from(rect.width),
        cx.theme.muted,
    );
    let x0 = rect.x + prefix.width() as u16;
    let room = rect.width.saturating_sub(prefix.width() as u16);
    let shown = skip_cells(n.field.value(), n.field.scroll(usize::from(room.max(1))));
    buf.set_stringn(x0, rect.y, &shown, usize::from(room), cx.theme.text);
    if cx.focused && room > 0 && !n.busy {
        let at = n.field.cursor().min(usize::from(room - 1));
        buf.set_style(Rect::new(x0 + at as u16, rect.y, 1, 1), styles.caret);
    }
    if let Some(error) = error
        && rect.height > 1
    {
        buf.set_stringn(
            rect.x,
            rect.y + 1,
            error,
            usize::from(rect.width),
            cx.theme.error,
        );
    }
}

/// A popup next to the caret: below it when there is room, above it when not.
/// A list shows the rows around the one the Enter key takes.
/// Where a popup is and which of its rows it shows: below the caret when
/// there is room, above it when not. `None` when there is nothing to draw.
pub(super) fn popup_place(
    popup: &Popup,
    caret: Option<Caret>,
    area: Rect,
) -> Option<(Rect, usize)> {
    if area.width == 0 || area.height == 0 {
        return None;
    }
    let rows = popup.rows();
    let (first, shown) = popup.window(usize::from(area.height));
    if shown == 0 {
        return None;
    }
    let widest = rows[first..first + shown]
        .iter()
        .map(|r| r.width())
        .max()
        .unwrap_or(0)
        + 2;
    let width = widest.min(70).min(usize::from(area.width)) as u16;
    let height = shown as u16;
    let anchor = caret.unwrap_or(Caret {
        x: area.x,
        y: area.y,
        width: 1,
    });
    let below = anchor.y + 1;
    let y = if below + height <= area.y + area.height {
        below
    } else {
        anchor.y.saturating_sub(height).max(area.y)
    };
    let x = anchor.x.min(area.x + area.width - width);
    Some((Rect::new(x, y, width, height), first))
}

/// A popup next to the caret. A list shows the rows from where the wheel or
/// the keys left it.
fn draw_popup(
    popup: &Popup,
    caret: Option<Caret>,
    area: Rect,
    buf: &mut Buffer,
    styles: &EditorStyles,
) {
    let Some((place, first)) = popup_place(popup, caret, area) else {
        return;
    };
    let rows = popup.rows();
    let window = &rows[first..first + usize::from(place.height)];
    let (x, y, width) = (place.x, place.y, place.width);
    for (i, text) in window.iter().enumerate() {
        let selected = popup.selected() == Some(first + i);
        let style = if selected {
            styles.popup_selected
        } else {
            styles.popup
        };
        let row = Rect::new(x, y + i as u16, width, 1);
        buf.set_style(row, style);
        buf.set_stringn(
            row.x + 1,
            row.y,
            text,
            usize::from(width.saturating_sub(2)),
            style,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_gives_up_its_leading_directories_then_the_middle_of_its_name() {
        let p = "docs/plans/notes.txt";
        assert_eq!(shorten_path(p, 20), p);
        assert_eq!(shorten_path(p, 19), "\u{2026}/plans/notes.txt");
        assert_eq!(shorten_path(p, 16), "\u{2026}/notes.txt");
        assert_eq!(shorten_path(p, 9), "notes.txt");
        assert_eq!(shorten_path(p, 8), "not\u{2026}.txt");
        assert_eq!(shorten_path(p, 1), "\u{2026}");
        assert_eq!(shorten_path(p, 0), "");
    }

    #[test]
    fn buttons_wrap_and_lose_the_hint_before_the_label() {
        let all = [
            Choice::KeepMine,
            Choice::TakeTheirs,
            Choice::KeepBoth,
            Choice::CopyMine,
        ];
        assert_eq!(layout_buttons(&all, 200).len(), 1);
        let narrow = layout_buttons(&all, 24);
        assert!(narrow.len() >= 3);
        for (_, text) in narrow.iter().flatten() {
            assert!(text.width() <= 24, "{text}");
        }
        let disk = layout_buttons(&[Choice::KeepDisk], 24);
        assert_eq!(disk[0][0].1, "[Take the file on disk]");
        let tiny = layout_buttons(&[Choice::KeepDisk], 10);
        assert!(tiny[0][0].1.width() <= 10 && tiny[0][0].1.ends_with("\u{2026}]"));
    }
}
