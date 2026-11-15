//! Draws the panel into a Ratatui `Buffer`.
//!
//! Translated from ELY-Open-Source/ELYTerminal at fbb536ec8f6e1466fa8c736967671ebf99a34080
//! `src/git/panel/view.rs` (blob 9e1cfe63f7490d521efe1ddf1675c6a738a624e7): the branch
//! line, the error alert, the changes list, the commit box and the recent commits, in the
//! donor's order.
//!
//! Translated from ELY-Open-Source/Ely-GPUI-Components at 294a8323c08a06bd8e7782d16acee43b6bb0c5eb
//! (MIT): `src/git/changes.rs` (blob 9591530a7aadc9f88b726afd97d81a1079ecc795), a row's
//! badge, name and dimmer folder, the section heading with its count, the subject counter
//! that warns past 50 and errs past 72, the amend box and the commit button; and
//! `src/git/diff.rs` (blob 657bb79eddc498eb418061f5c64c49090b32d64c) the unified and the
//! side-by-side layouts of a hunk's lines.
//!
//! Draws, not yet compared against a reference: no rendered reference of the donor exists.

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Modifier, Style};
use theorem_workbench_core::completion::LogEntry;

use crate::diff::{DiffLine, LineKind};
use crate::layout::{
    LIMITS, Row, Tone, banners, branch_controls, control_label, regions, rows, verbs,
};
use crate::model::{Changes, DiffLayout, Field, Focus, LogState, Mode, Prompt};
use crate::status::{Section, letter, shown};
use crate::styles::ChangesStyles;
use crate::text::{elide_middle, fit, paint, printable, put, put_marked, width};

/// The narrowest a panel draws a split diff at; narrower, the diff is unified.
pub const SPLIT_MIN: u16 = 50;

fn tone(styles: &ChangesStyles, tone: Tone) -> Style {
    match tone {
        Tone::Plain => styles.text,
        Tone::Muted => styles.muted,
        Tone::Warning => styles.warning,
        Tone::Error => styles.error,
        Tone::Added => styles.added_line,
        Tone::Removed => styles.removed_line,
        Tone::Cursor => styles.cursor,
    }
}

pub(crate) fn letter_style(styles: &ChangesStyles, section: Section, c: char) -> Style {
    match (section, c) {
        (Section::Conflicted, _) => styles.letter_conflict,
        (Section::Untracked, _) => styles.letter_untracked,
        (_, 'A') => styles.letter_added,
        (_, 'D') => styles.letter_deleted,
        (_, '?') => styles.letter_untracked,
        _ => styles.letter_changed,
    }
}

/// The verbs a row offers, as the cursor row's hint shows them.
pub(crate) fn offered(section: Section) -> String {
    verbs(section)
        .iter()
        .map(|(word, _)| *word)
        .collect::<Vec<_>>()
        .join("  ")
}

impl Changes {
    /// Whether the diffs are drawn side by side at this width.
    pub(crate) fn split_at(&self, width: u16) -> bool {
        self.layout == DiffLayout::Split && width >= SPLIT_MIN
    }

    pub fn draw(&self, area: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        let area = area.intersection(buf.area);
        if area.width == 0 || area.height == 0 {
            return;
        }
        paint(buf, area, styles.text);
        let regions = regions(self, area);
        self.draw_branch(regions.branch, buf, styles);
        self.draw_banners(regions.banners, buf, styles);
        self.draw_list(regions.list, buf, styles);
        self.draw_commit(regions.commit, buf, styles);
        self.draw_log(regions.log, buf, styles);
    }

    /// The amend box's words. Always drawn: without `scm.commit.amend` it is muted and the
    /// semantic node says why it cannot be used.
    pub(crate) fn amend_text(&self) -> String {
        format!("[{}] Amend", if self.amend { "x" } else { " " })
    }

    /// Shows the caret as a reversed cell, the way a terminal draws a block cursor.
    fn draw_caret(&self, field: Field, row: usize, x: u16, y: u16, room: usize, buf: &mut Buffer) {
        let Some(caret) = self.caret else { return };
        if caret.field != field || caret.row != row {
            return;
        }
        let col = caret.col.min(room.saturating_sub(1));
        let at = x + col as u16;
        if let Some(cell) = buf.cell_mut((at, y)) {
            cell.modifier.insert(Modifier::REVERSED);
        }
    }

    fn draw_prompt(&self, prompt: &Prompt, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        let label = format!("{}: ", prompt.kind.label());
        let lw = width(&label);
        put(
            buf,
            rect.x,
            rect.y,
            rect.width as usize,
            &label,
            styles.heading,
        );
        let room = (rect.width as usize).saturating_sub(lw);
        let text = printable(&prompt.text);
        // A long name shows its end, where the caret is.
        let skip = width(&text).saturating_sub(room.saturating_sub(1));
        let shown: String = text.chars().skip(skip).collect();
        put(buf, rect.x + lw as u16, rect.y, room, &shown, styles.text);
        self.draw_caret(Field::Prompt, 0, rect.x + lw as u16, rect.y, room, buf);
    }

    fn draw_branch(&self, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        if rect.height == 0 {
            return;
        }
        if let Some(prompt) = &self.prompt {
            return self.draw_prompt(prompt, rect, buf, styles);
        }
        let label = match self.head() {
            Some(head) => head.label(),
            None => "reading...".to_owned(),
        };
        let busy: Vec<&str> = self
            .in_flight()
            .into_iter()
            .map(|action| action.label())
            .collect();
        let tail = if busy.is_empty() {
            String::new()
        } else {
            format!("working: {}", busy.join(", "))
        };
        let room = rect.width as usize;
        let controls = branch_controls(self, rect.width);
        let tail_w = width(&tail);
        let label_room = if tail_w > 0 && room > tail_w + 6 {
            room - tail_w - 2
        } else {
            room
        };
        put(
            buf,
            rect.x,
            rect.y,
            label_room,
            &printable(&elide_middle(&label, label_room)),
            styles.heading,
        );
        if tail_w > 0 && room > tail_w + 6 {
            put(
                buf,
                rect.x + (room - tail_w) as u16,
                rect.y,
                tail_w,
                &tail,
                styles.muted,
            );
        }
        for (control, at, w) in controls {
            let label = control_label(control);
            if !label.is_empty() {
                put(buf, rect.x + at, rect.y, w as usize, label, styles.button);
            }
        }
    }

    fn draw_banners(&self, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        for (at, (t, line)) in banners(self)
            .into_iter()
            .take(rect.height as usize)
            .enumerate()
        {
            let line = fit(&printable(&line), rect.width as usize);
            put(
                buf,
                rect.x,
                rect.y + at as u16,
                rect.width as usize,
                &line,
                tone(styles, t),
            );
        }
    }

    fn draw_list(&self, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        if rect.height == 0 || rect.width == 0 {
            return;
        }
        let rows = rows(self, self.split_at(rect.width));
        let first = self
            .scroll()
            .min(rows.len().saturating_sub(rect.height as usize));
        for (at, row) in rows
            .iter()
            .skip(first)
            .take(rect.height as usize)
            .enumerate()
        {
            let line = Rect::new(rect.x, rect.y + at as u16, rect.width, 1);
            self.draw_row(row, line, buf, styles);
        }
    }

    fn draw_row(&self, row: &Row<'_>, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        let w = rect.width as usize;
        match row {
            Row::Header { section, count } => {
                let title = format!("{} {count}", section.title());
                put(
                    buf,
                    rect.x + 1,
                    rect.y,
                    w.saturating_sub(1),
                    &title,
                    styles.heading,
                );
                let hint = match section {
                    Section::Staged => "unstage all",
                    Section::Unstaged => "stage all",
                    _ => "",
                };
                let hw = width(hint);
                if hw > 0 && w > width(&title) + hw + 4 {
                    put(
                        buf,
                        rect.x + (w - hw) as u16,
                        rect.y,
                        hw,
                        hint,
                        styles.muted,
                    );
                }
            }
            Row::File {
                key,
                change,
                expanded,
            } => {
                let cursor = self.cursor.as_ref() == Some(key);
                let selected = self.selected.contains(key);
                let row_style = match (cursor, selected) {
                    (true, _) if self.focus == Focus::Files && self.mode == Mode::Changes => {
                        styles.cursor
                    }
                    (true, _) => styles.cursor_idle,
                    (false, true) => styles.selected,
                    (false, false) => styles.text,
                };
                paint(buf, rect, row_style);
                let c = letter(key.section, change);
                put(
                    buf,
                    rect.x + 1,
                    rect.y,
                    1,
                    if *expanded { "v" } else { ">" },
                    row_style,
                );
                let letter_style = row_style.patch(letter_style(styles, key.section, c));
                put(buf, rect.x + 3, rect.y, 1, &c.to_string(), letter_style);
                let hint = if cursor {
                    offered(key.section)
                } else {
                    String::new()
                };
                let hint = hint.as_str();
                let hint_w = width(hint);
                let body_x = 5usize;
                let mut room = w.saturating_sub(body_x);
                let hint_at = if hint_w > 0 && room > hint_w + 12 {
                    room -= hint_w + 1;
                    Some(w - hint_w)
                } else {
                    None
                };
                let shown = shown(&key.path);
                let (folder, name) = match shown.rsplit_once('/') {
                    Some((folder, name)) => (folder.to_owned(), name.to_owned()),
                    None => (String::new(), shown),
                };
                let name = printable(&name);
                let name = elide_middle(&name, room);
                let mut x = rect.x + body_x as u16;
                let name_style = if matches!(change.worktree.as_str(), "D")
                    && key.section == Section::Unstaged
                    || key.section == Section::Staged && change.index == "D"
                {
                    row_style.patch(styles.removed_line)
                } else {
                    row_style
                };
                let used = put(buf, x, rect.y, room, &name, name_style);
                x += used as u16;
                let left = room.saturating_sub(used);
                if !folder.is_empty() && left > 4 {
                    let folder = elide_middle(&printable(&folder), left - 2);
                    put(
                        buf,
                        x + 2,
                        rect.y,
                        left - 2,
                        &folder,
                        row_style.patch(styles.muted),
                    );
                }
                if let Some(at) = hint_at {
                    put(
                        buf,
                        rect.x + at as u16,
                        rect.y,
                        hint_w,
                        hint,
                        row_style.patch(styles.muted),
                    );
                }
            }
            Row::Hunk {
                hunk,
                folded,
                current,
                ..
            } => {
                let style = if *current {
                    styles.hunk_current
                } else {
                    styles.hunk_header
                };
                let marker = if *folded { ">" } else { "v" };
                paint(buf, rect, style);
                put(buf, rect.x + 2, rect.y, 1, marker, style);
                let mut header = hunk.header.clone();
                if *folded {
                    header.push_str(&format!(" ({} lines)", hunk.lines.len()));
                }
                let header = fit(&printable(&header), w.saturating_sub(4));
                put(buf, rect.x + 4, rect.y, w.saturating_sub(4), &header, style);
            }
            Row::Line { line, digits, .. } => self.draw_unified(line, *digits, rect, buf, styles),
            Row::Pair {
                left,
                right,
                digits,
                ..
            } => self.draw_pair(*left, *right, *digits, rect, buf, styles),
            Row::Text {
                text,
                tone: t,
                indent,
            } => {
                let pad = *indent as usize;
                let room = w.saturating_sub(pad + 1);
                put(
                    buf,
                    rect.x + 1 + *indent,
                    rect.y,
                    room,
                    &fit(&printable(text), room),
                    tone(styles, *t),
                );
            }
            Row::Branch { info, cursor } => {
                let style = if *cursor { styles.cursor } else { styles.text };
                paint(buf, rect, style);
                let mark = if info.current { "*" } else { " " };
                put(buf, rect.x + 1, rect.y, 1, mark, style);
                let mut label = info.name.clone();
                if info.remote {
                    label.push_str("  (remote)");
                }
                if let Some(upstream) = &info.upstream {
                    label.push_str(&format!("  tracks {upstream}"));
                }
                let room = w.saturating_sub(3);
                put(
                    buf,
                    rect.x + 3,
                    rect.y,
                    room,
                    &elide_middle(&printable(&label), room),
                    style,
                );
            }
        }
    }

    fn line_style(styles: &ChangesStyles, kind: LineKind) -> (Style, Style) {
        match kind {
            LineKind::Same => (styles.text, styles.text),
            LineKind::Added => (styles.added_line, styles.added_words),
            LineKind::Removed => (styles.removed_line, styles.removed_words),
        }
    }

    fn draw_unified(
        &self,
        line: &DiffLine,
        digits: usize,
        rect: Rect,
        buf: &mut Buffer,
        styles: &ChangesStyles,
    ) {
        let (base, words) = Self::line_style(styles, line.kind);
        paint(buf, rect, base);
        let number = |n: Option<usize>| match n {
            Some(n) => format!("{n:>digits$}"),
            None => " ".repeat(digits),
        };
        let gutter = format!("{} {} ", number(line.old), number(line.new));
        let gutter_w = width(&gutter);
        let x0 = rect.x + 2;
        let w = (rect.width as usize).saturating_sub(2);
        put(buf, x0, rect.y, w, &gutter, base.patch(styles.gutter));
        let sign = match line.kind {
            LineKind::Same => " ",
            LineKind::Added => "+",
            LineKind::Removed => "-",
        };
        if w > gutter_w {
            put(buf, x0 + gutter_w as u16, rect.y, 1, sign, base);
            put_marked(
                buf,
                x0 + gutter_w as u16 + 1,
                rect.y,
                w.saturating_sub(gutter_w + 1),
                &line.text,
                &line.words,
                (base, words),
            );
        }
    }

    fn draw_pair(
        &self,
        left: Option<&DiffLine>,
        right: Option<&DiffLine>,
        digits: usize,
        rect: Rect,
        buf: &mut Buffer,
        styles: &ChangesStyles,
    ) {
        let total = (rect.width as usize).saturating_sub(2);
        let half = total.saturating_sub(1) / 2;
        let left_rect = Rect::new(rect.x + 2, rect.y, half as u16, 1);
        let right_x = rect.x + 2 + half as u16 + 1;
        let right_w = total.saturating_sub(half + 1);
        let right_rect = Rect::new(right_x, rect.y, right_w as u16, 1);
        for (side, rect, number) in [
            (left, left_rect, left.and_then(|l| l.old)),
            (right, right_rect, right.and_then(|l| l.new)),
        ] {
            let kind = side.map(|l| l.kind);
            let (base, words) =
                kind.map_or((styles.text, styles.text), |k| Self::line_style(styles, k));
            paint(buf, rect, base);
            let Some(line) = side else { continue };
            let gutter = match number {
                Some(n) => format!("{n:>digits$} "),
                None => format!("{} ", " ".repeat(digits)),
            };
            let gw = width(&gutter);
            put(
                buf,
                rect.x,
                rect.y,
                rect.width as usize,
                &gutter,
                base.patch(styles.gutter),
            );
            put_marked(
                buf,
                rect.x + gw as u16,
                rect.y,
                (rect.width as usize).saturating_sub(gw),
                &line.text,
                &line.words,
                (base, words),
            );
        }
        put(buf, rect.x + 2 + half as u16, rect.y, 1, "│", styles.line);
    }

    fn draw_commit(&self, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        if rect.height == 0 || rect.width == 0 {
            return;
        }
        let w = rect.width as usize;
        let focused = self.focus == Focus::Message;
        let mark = |on: bool| if on { ">" } else { " " };
        // The subject and its counter.
        let length = self.subject.chars().count();
        let counter = format!("{length}/{}", LIMITS.0);
        let counter_style = match length {
            n if n > LIMITS.1 => styles.error,
            n if n > LIMITS.0 => styles.warning,
            _ => styles.muted,
        };
        put(buf, rect.x, rect.y, 1, mark(focused), styles.field_focus);
        let subject_room = w.saturating_sub(counter.len() + 3);
        let (subject, style) = if self.subject.is_empty() {
            ("Commit message".to_owned(), styles.muted)
        } else {
            (
                fit(
                    &printable(self.subject.lines().next().unwrap_or("")),
                    subject_room,
                ),
                styles.text,
            )
        };
        put(buf, rect.x + 2, rect.y, subject_room, &subject, style);
        if focused {
            self.draw_caret(Field::Subject, 0, rect.x + 2, rect.y, subject_room, buf);
        }
        put(
            buf,
            rect.x + (w - counter.len()) as u16,
            rect.y,
            counter.len(),
            &counter,
            counter_style,
        );
        if rect.height >= 4 {
            // Two body lines show: the caret's line and the one above it.
            let first = self
                .caret
                .filter(|c| c.field == Field::Body)
                .map_or(0, |c| c.row.saturating_sub(1));
            let mut lines = self.body.split('\n').skip(first);
            for row in 1..=2u16 {
                let (line, style) = match lines.next() {
                    Some(_) if self.body.is_empty() => ("Description".to_owned(), styles.muted),
                    Some(line) => (line.to_owned(), styles.text),
                    None => (String::new(), styles.text),
                };
                put(
                    buf,
                    rect.x + 2,
                    rect.y + row,
                    w.saturating_sub(3),
                    &fit(&printable(&line), w.saturating_sub(3)),
                    style,
                );
                if self.focus == Focus::Message {
                    let shown_row = first + usize::from(row) - 1;
                    self.draw_caret(
                        Field::Body,
                        shown_row,
                        rect.x + 2,
                        rect.y + row,
                        w.saturating_sub(3),
                        buf,
                    );
                }
            }
        }
        // The amend box and the button.
        let y = rect.y + rect.height - 1;
        let amend = self.amend_text();
        let amend_style = if self.amend_available() {
            styles.text
        } else {
            styles.muted
        };
        put(buf, rect.x + 1, y, w.saturating_sub(1), &amend, amend_style);
        let (label, ready) = self.commit_button();
        let label = format!("[ {label} ]");
        let room = w.saturating_sub(width(&amend) + 3);
        let label = fit(&label, room);
        let lw = width(&label);
        if lw > 0 {
            put(
                buf,
                rect.x + (w - lw) as u16,
                y,
                lw,
                &label,
                if ready {
                    styles.button
                } else {
                    styles.button_disabled
                },
            );
        }
    }

    /// The commit button's words and whether it can be pressed (donor `ready`, widened
    /// by the Theia view's "Stage All and Commit").
    pub fn commit_button(&self) -> (String, bool) {
        let branch = self
            .head()
            .map(|h| h.label())
            .unwrap_or_else(|| "branch".to_owned());
        let (staged, unstaged) = self
            .groups()
            .map(|g| (g.staged.len(), g.unstaged.len()))
            .unwrap_or((0, 0));
        let busy = self.is_busy(crate::intent::ActionKind::Commit)
            || self.is_busy(crate::intent::ActionKind::Stage);
        let has_subject = !self.subject.trim().is_empty();
        if busy {
            let label = if self.is_busy(crate::intent::ActionKind::Stage) {
                "Staging..."
            } else if self.amend {
                "Amending..."
            } else {
                "Committing..."
            };
            return (label.to_owned(), false);
        }
        if staged == 0 && !self.amend && unstaged > 0 {
            return (format!("Stage all and commit to {branch}"), has_subject);
        }
        (
            if self.amend {
                format!("Amend {branch}")
            } else {
                format!("Commit to {branch}")
            },
            has_subject && (staged > 0 || self.amend),
        )
    }

    fn draw_log(&self, rect: Rect, buf: &mut Buffer, styles: &ChangesStyles) {
        if rect.height == 0 || rect.width == 0 {
            return;
        }
        let w = rect.width as usize;
        let focused = self.focus == Focus::Log;
        put(
            buf,
            rect.x + 1,
            rect.y,
            w.saturating_sub(1),
            "Commits",
            styles.heading,
        );
        match &self.log {
            LogState::Ready(entries) => {
                for (at, entry) in entries.iter().take(rect.height as usize - 1).enumerate() {
                    let line = Rect::new(rect.x, rect.y + 1 + at as u16, rect.width, 1);
                    let cursor = focused && at == self.log_cursor;
                    self.draw_log_row(entry, cursor, line, buf, styles);
                }
            }
            LogState::Problem(problem) => {
                let t = crate::layout::problem_tone(problem);
                put(
                    buf,
                    rect.x + 1,
                    rect.y + 1,
                    w.saturating_sub(1),
                    &fit(&printable(&problem.text()), w - 1),
                    tone(styles, t),
                );
            }
            LogState::Outdated => {
                put(
                    buf,
                    rect.x + 1,
                    rect.y + 1,
                    w.saturating_sub(1),
                    &fit(
                        "The log was for an earlier state and was dropped. Refresh to read it.",
                        w - 1,
                    ),
                    styles.warning,
                );
            }
            LogState::Loading => {
                put(
                    buf,
                    rect.x + 1,
                    rect.y + 1,
                    w.saturating_sub(1),
                    "Reading the log...",
                    styles.muted,
                );
            }
            LogState::Idle | LogState::NoCommits => {}
        }
    }

    fn draw_log_row(
        &self,
        entry: &LogEntry,
        cursor: bool,
        rect: Rect,
        buf: &mut Buffer,
        styles: &ChangesStyles,
    ) {
        let style = if cursor { styles.cursor } else { styles.text };
        paint(buf, rect, style);
        let short: String = entry.commit.chars().take(7).collect();
        put(
            buf,
            rect.x + 1,
            rect.y,
            7,
            &short,
            style.patch(styles.muted),
        );
        let w = rect.width as usize;
        let author = printable(&entry.author);
        let author_w = width(&author).min(w / 4);
        let room = w.saturating_sub(10);
        let subject_room = room.saturating_sub(if author_w > 0 { author_w + 2 } else { 0 });
        let subject = fit(&printable(&entry.subject), subject_room);
        put(buf, rect.x + 9, rect.y, subject_room, &subject, style);
        if author_w > 0 && subject_room + 2 <= room {
            let at = rect.x + 9 + subject_room as u16 + 2;
            put(
                buf,
                at,
                rect.y,
                author_w,
                &elide_middle(&author, author_w),
                style.patch(styles.muted),
            );
        }
    }
}
