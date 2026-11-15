//! The notice row: the one line the workbench says what just happened in.
//!
//! It has a place of its own, the bottom row of the frame, and that row costs
//! the dock a line only while a notice is showing. It is drawn by [`view`] and
//! named in the semantic tree as a status, from the same text.
//!
//! Two kinds share it. A *persistent* notice is a standing fact about the
//! workbench (the layout on screen is this device's copy, not the account's):
//! it shows while the fact holds and goes when it stops. A *transient* notice
//! is what an operation did or refused: it shows until the next key press or
//! the next notice, whichever comes first, and then the persistent one, if
//! any, shows again.
//!
//! [`view`]: crate::view::view

use ratatui::layout::Rect;

use crate::arrangement::ArrangementNotice;
use crate::ids::Actor;
use crate::model::{Model, Notice};
use crate::registry::Refusal;
use crate::theme::Theme;
use ratatui::style::Style;

/// How a notice reads. Each is a state role of the theme.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoticeSeverity {
    /// Something happened that needs no attention (`chrome.muted`).
    Info,
    /// What was asked was done (`state.success`).
    Success,
    /// Done in part, or not done and fixable (`state.warning`).
    Warning,
    /// Not done, and why (`state.error`).
    Error,
}

impl NoticeSeverity {
    /// The theme's style for this severity.
    pub fn style(self, theme: &Theme) -> Style {
        match self {
            Self::Info => theme.muted,
            Self::Success => theme.success,
            Self::Warning => theme.warning,
            Self::Error => theme.error,
        }
    }

    /// The word the semantic tree gives it.
    pub fn word(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Success => "success",
            Self::Warning => "warning",
            Self::Error => "error",
        }
    }
}

/// What the notice row shows now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NoticeLine {
    pub text: String,
    pub severity: NoticeSeverity,
    /// A standing fact, not the answer to something just done.
    pub persistent: bool,
}

/// What the layout on screen being this device's copy says.
pub const DEVICE_COPY: &str = "Layout: this device's copy, not your account's";

/// The words and severity of a notice; `None` for one that is only a standing
/// fact and has its own persistent line.
pub(crate) fn describe(notice: &Notice) -> Option<(String, NoticeSeverity)> {
    use NoticeSeverity::{Error, Info, Warning};
    Some(match notice {
        Notice::Refused(Refusal::Unavailable { reason }) => (reason.clone(), Warning),
        Notice::Refused(Refusal::UnknownPanel(panel)) => (
            format!("There is no open panel \"{}\".", panel.as_str()),
            Error,
        ),
        Notice::Refused(Refusal::UnknownAction(id)) => {
            (format!("There is no action \"{}\".", id.as_str()), Error)
        }
        Notice::Refused(Refusal::HumanOnly { action, actor }) => (
            match actor {
                Actor::Human => format!("\"{}\" is for a person to do.", action.as_str()),
                Actor::Agent { run_id } => format!(
                    "\"{}\" is for a person to do. Agent run {run_id} asked for it.",
                    action.as_str()
                ),
            },
            Warning,
        ),
        Notice::Dock(error) => (error.to_string(), Warning),
        Notice::NoPanel(id) => (
            format!("Open a panel for \"{}\" first.", id.as_str()),
            Warning,
        ),
        Notice::EffectsFull { limit } => (
            format!("Too many requests are waiting ({limit}). Try again when they finish."),
            Warning,
        ),
        Notice::Overflow { dropped } => (format!("{dropped} notices were missed."), Info),
        Notice::Arrangement(told) => return describe_arrangement(told),
    })
}

fn describe_arrangement(told: &ArrangementNotice) -> Option<(String, NoticeSeverity)> {
    use ArrangementNotice as N;
    use NoticeSeverity::{Error, Success, Warning};
    Some(match told {
        N::Applied { name } => (format!("Layout: {name} applied"), Success),
        N::Partial {
            name,
            dropped,
            unavailable,
            ..
        } => {
            let mut said = format!("Layout: {name} applied");
            if !dropped.is_empty() {
                said.push_str(&format!(", without {} (no such panel)", dropped.join(", ")));
            }
            if !unavailable.is_empty() {
                said.push_str(&format!(
                    ", with {} as placeholders",
                    unavailable.join(", ")
                ));
            }
            (said, Warning)
        }
        N::Unreadable { name, reason } => (format!("Layout: {name} unreadable ({reason})"), Error),
        N::Unknown { name } => (format!("Layout: there is none named {name}"), Warning),
        N::Saved { name } => (format!("Layout: {name} saved"), Success),
        N::Renamed { from, to } => (format!("Layout: {from} renamed {to}"), Success),
        N::Deleted { name } => (format!("Layout: {name} deleted"), Success),
        N::BadAppearance { reason } => (format!("Layout: theme not kept ({reason})"), Warning),
        N::AppearanceNotApplied { name, reason } => (
            format!("Layout: {name} applied, but its saved theme could not be ({reason})"),
            Warning,
        ),
        N::BadName { reason } => (format!("Layout: name refused ({reason})"), Warning),
        N::NameTaken { name } => (format!("Layout: {name} is already taken"), Warning),
        N::StoreFull { limit } => (format!("Layout: {limit} layouts are kept already"), Warning),
        N::NotSaved { reason } => (format!("Layout: not saved ({reason})"), Error),
        N::NeedsAccountLoad { reason } => (format!("Layout: not saved ({reason})"), Warning),
        N::LoadedWithLoss { skipped, reason } => (
            format!("Layout: {skipped} entries skipped ({reason})"),
            Warning,
        ),
        // A standing fact: the persistent line says it for as long as it holds.
        N::DeviceCopy => return None,
    })
}

impl Model {
    /// What the notice row says now: the latest transient notice, else the
    /// persistent one that holds, else nothing. The core draws it in the frame
    /// ([`crate::view`]) and names it in the semantic tree, so a host draws no
    /// notice of its own.
    pub fn notice_line(&self) -> Option<NoticeLine> {
        self.transient.clone().or_else(|| {
            self.layout_is_device_copy().then(|| NoticeLine {
                text: DEVICE_COPY.to_owned(),
                severity: NoticeSeverity::Warning,
                persistent: true,
            })
        })
    }

    /// Stop queueing notices for [`take_notice`](Model::take_notice). A host
    /// that reads the row from the core ([`notice_line`](Model::notice_line))
    /// and never takes notices says so once, and the queue then neither fills
    /// nor reports lost notices. Notices are queued by default.
    pub fn set_notice_queue(&mut self, queue: bool) {
        self.queue_notices = queue;
        if !queue {
            self.notices.clear();
            self.notices_overflowed = 0;
        }
    }

    /// The row the persistent notice takes in a frame of `full`, while one
    /// holds and the frame is tall enough to spare it. Only the persistent
    /// notice takes a row, so the dock reflows when that state begins or ends
    /// and never for a transient notice.
    pub fn notice_row(&self, full: Rect) -> Option<Rect> {
        (full.height >= 2 && self.layout_is_device_copy())
            .then(|| Rect::new(full.x, full.bottom() - 1, full.width, 1))
    }

    /// Where the notice line is drawn: the persistent row, else, for a
    /// transient notice, the right end of the frame's bottom row, as wide as
    /// its text plus a cell of padding each side (or the frame's width).
    pub fn notice_rect(&self, full: Rect) -> Option<Rect> {
        let line = self.notice_line()?;
        if let Some(row) = self.notice_row(full) {
            return Some(row);
        }
        if full.height == 0 || full.width == 0 {
            return None;
        }
        let wide = u16::try_from(line.text.chars().count() + 2).unwrap_or(u16::MAX);
        let wide = wide.min(full.width);
        Some(Rect::new(full.right() - wide, full.bottom() - 1, wide, 1))
    }

    /// The cells the dock is solved in for a frame of `full`: all of it, less
    /// the notice row while one shows.
    pub fn dock_area_in(&self, full: Rect) -> Rect {
        match self.notice_row(full) {
            Some(_) => Rect::new(full.x, full.y, full.width, full.height - 1),
            None => full,
        }
    }

    /// Show `notice` on the row, replacing a transient one.
    pub(crate) fn show_notice(&mut self, notice: &Notice) {
        if let Some((text, severity)) = describe(notice) {
            self.transient = Some(NoticeLine {
                text,
                severity,
                persistent: false,
            });
        }
    }

    /// A key press is the next thing done: the transient notice has been read.
    pub(crate) fn clear_transient_notice(&mut self) {
        if self.transient.take().is_some() {
            self.dirty = true;
        }
    }
}
