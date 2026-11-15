//! Keys, text, the pointer, and the choices they start.

use keybinds::{Key, KeyInput, Mods};
use ratatui::layout::Rect;
use theorem_workbench_core::effect::{EffectBody, ReconcileKeep};
use theorem_workbench_core::{Button, Ctx, OpenTarget, PanelPointer, PointerKind};
use theorem_workbench_editor::Clipboard;
use theorem_workbench_editor::Reaction;
use theorem_workbench_markdown::{Anchor, BlockInfo, CommitOutcome, MarkdownDoc, MarkdownMode};
use theorem_workbench_text::{EditError, Resolution, Snap, Unit};

use super::flow::emit_notice;
use super::{Clip, Doc, MarkdownPanel, Phase, Tone};
use crate::actions::Choice;
use crate::links::{self, Target};

impl Doc {
    /// The block the person is on: the open one, else the one holding the
    /// caret. The index is among `blocks`.
    pub(super) fn block_position(&self) -> (Option<usize>, Vec<BlockInfo>) {
        let mut md = self.md.borrow_mut();
        let blocks = md.blocks();
        let index = match md.open_range() {
            Some(range) => blocks.iter().position(|b| b.range.start == range.start),
            None => {
                let at = md.cursor_byte();
                md.block_at(at)
            }
        };
        (index, blocks)
    }
}

/// The chord a key is, when it is one. Alt and a letter belong to the panel
/// only for the letters it uses: any other Alt combination is the widget's.
fn chord(key: &KeyInput, editing: bool, block_open: bool) -> Option<Choice> {
    let mods = key.mods();
    let command = mods.intersects(Mods::CTRL | Mods::CMD);
    let alt = mods.contains(Mods::ALT);
    // Mod and Alt together is the workbench's own chord space, and on some
    // layouts the way to type a character: not ours either way.
    if command && alt {
        return None;
    }
    match key.key() {
        Key::Char(c) if command => match c.to_ascii_lowercase() {
            's' => Some(Choice::Save),
            _ => None,
        },
        Key::Char(c) if alt => match c.to_ascii_lowercase() {
            '1' => Some(Choice::Visual),
            '2' => Some(Choice::Source),
            '3' => Some(Choice::Split),
            '4' => Some(Choice::Preview),
            'x' => Some(Choice::ToggleCheckbox),
            'm' => Some(Choice::KeepMine),
            't' => Some(Choice::TakeTheirs),
            'b' => Some(Choice::KeepBoth),
            'y' => Some(Choice::CopyMine),
            'r' => Some(Choice::Resend),
            'd' => Some(Choice::KeepDisk),
            'k' => Some(Choice::KeepAuthority),
            'j' => Some(Choice::KeepRecovered),
            'g' => Some(Choice::DiscardRecovered),
            _ => None,
        },
        Key::Enter if alt => Some(Choice::OpenLink),
        Key::Down if alt => Some(Choice::NextBlock),
        Key::Up if alt => Some(Choice::PreviousBlock),
        Key::Esc if block_open => Some(Choice::CloseBlock),
        Key::Esc => Some(Choice::Dismiss),
        // Where nothing takes text, the keys that would type are the panel's.
        Key::Enter if !editing && !alt => Some(Choice::OpenBlock),
        Key::Tab if !editing && mods.contains(Mods::SHIFT) => Some(Choice::PreviousLink),
        Key::Tab if !editing => Some(Choice::NextLink),
        _ => None,
    }
}

impl MarkdownPanel {
    /// Whether keys type into a text surface now.
    pub(super) fn typing(&self, d: &Doc) -> bool {
        match self.shown(d).mode {
            MarkdownMode::Source | MarkdownMode::Split => true,
            // A block held open on a read-only document takes no text.
            MarkdownMode::Visual => {
                d.sync.read_only.is_none() && d.md.borrow().open_range().is_some()
            }
            MarkdownMode::Preview => false,
        }
    }

    /// The chord a key is in the state the panel is in, for `on_key` to do and
    /// `takes_chord` to ask: what is typed and whether a block is open decide
    /// which keys are the panel's.
    fn chord_choice(&self, key: &KeyInput) -> Option<Choice> {
        let d = self.doc()?;
        let editing = self.typing(d);
        let block_open = self.shown(d).mode == MarkdownMode::Visual && editing;
        chord(key, editing, block_open)
    }

    /// Whether this chord is a command here and now. One the panel would only
    /// refuse ("There is nothing held.", the mode already shown) is left to be
    /// typed, so Option+T is a dagger until there is a conflict to settle.
    pub(super) fn takes_chord(&self, key: &KeyInput) -> bool {
        self.chord_choice(key)
            .is_some_and(|choice| self.unavailable(choice).is_none())
    }

    pub(super) fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        let Some(d) = self.doc() else {
            match key.key() {
                Key::Enter => self.choose(Choice::Retry, cx),
                Key::Esc => self.choose(Choice::Close, cx),
                _ => {}
            }
            return;
        };
        let editing = self.typing(d);
        if let Some(choice) = self.chord_choice(&key) {
            self.choose(choice, cx);
            return;
        }
        let mode = self.shown(d).mode;
        match mode {
            MarkdownMode::Source | MarkdownMode::Split => {
                let Some(d) = self.doc_mut() else { return };
                let reaction = d.md.get_mut().apply_local(|s| d.source.key(s, &key));
                if let Some(c) = self.settle(reaction) {
                    self.clipboard(c, false, cx);
                }
            }
            MarkdownMode::Visual if editing => {
                let Some(d) = self.doc_mut() else { return };
                let plain = key.mods().is_empty();
                if plain && matches!(key.key(), Key::Up | Key::Down) {
                    // At the block's first or last line the arrow goes on to
                    // the block beside it.
                    if let Some(outcome) = d.md.get_mut().step_block(key.key() == Key::Down) {
                        self.committed(outcome);
                        return;
                    }
                }
                let md = d.md.get_mut();
                let Some(session) = md.block_session() else {
                    return;
                };
                let reaction = d.block.key(session, &key);
                if let Some(c) = self.settle(reaction) {
                    self.clipboard(c, true, cx);
                }
            }
            MarkdownMode::Visual | MarkdownMode::Preview => self.read_key(&key, cx),
        }
    }

    /// A key where the document is read: the arrows move by block, the page
    /// keys by rows.
    fn read_key(&mut self, key: &KeyInput, cx: &mut Ctx) {
        let page = (self.body.1.saturating_sub(3) as isize).max(1);
        match key.key() {
            Key::Up => self.choose(Choice::PreviousBlock, cx),
            Key::Down => self.choose(Choice::NextBlock, cx),
            Key::PageUp | Key::PageDown => {
                let rows = if key.key() == Key::PageUp {
                    -page
                } else {
                    page
                };
                if let Some(d) = self.doc_mut() {
                    d.md.get_mut().scroll_by(rows);
                }
            }
            Key::Home => self.go_block_to(0),
            Key::End => self.go_block_to(usize::MAX),
            _ => {}
        }
    }

    pub(super) fn on_text(&mut self, text: &str) {
        let Some(d) = self.doc() else { return };
        let mode = self.shown(d).mode;
        let Some(d) = self.doc_mut() else { return };
        let reaction = match mode {
            MarkdownMode::Source | MarkdownMode::Split => {
                d.md.get_mut().apply_local(|s| d.source.text(s, text))
            }
            MarkdownMode::Visual => match d.md.get_mut().block_session() {
                Some(s) => d.block.text(s, text),
                None => return,
            },
            MarkdownMode::Preview => return,
        };
        self.settle(reaction);
    }

    pub(super) fn on_paste(&mut self, text: &str) {
        let Some(d) = self.doc() else { return };
        let mode = self.shown(d).mode;
        let Some(d) = self.doc_mut() else { return };
        let reaction = match mode {
            MarkdownMode::Source | MarkdownMode::Split => {
                d.md.get_mut().apply_local(|s| d.source.paste(s, text))
            }
            MarkdownMode::Visual => match d.md.get_mut().block_session() {
                Some(s) => d.block.paste(s, text),
                None => return,
            },
            MarkdownMode::Preview => return,
        };
        self.settle(reaction);
    }

    /// What an input did, in the panel's terms. A clipboard request comes back
    /// for the caller, which has the context to send it.
    fn settle(&mut self, reaction: Reaction) -> Option<Clipboard> {
        let Reaction {
            error, clipboard, ..
        } = reaction;
        if let Some(e) = error {
            let note = self.edit_error(&e);
            self.say(note, Tone::Warn);
        }
        clipboard
    }

    pub(super) fn edit_error(&self, error: &EditError) -> String {
        match error {
            EditError::ReadOnly => match self.doc() {
                Some(d) if d.sync.read_only.is_some() => {
                    format!(
                        "Read-only: {}",
                        d.sync.read_only.clone().unwrap_or_default()
                    )
                }
                Some(d) if d.md.borrow().mode() == MarkdownMode::Preview => {
                    "Preview shows the document and does not edit it: choose another mode."
                        .to_owned()
                }
                _ => "Read-only: the owner does not allow edits here.".to_owned(),
            },
            other => other.to_string(),
        }
    }

    /// A close or a switch wrote the open block back, or could not.
    pub(super) fn committed(&mut self, outcome: CommitOutcome) {
        match outcome {
            CommitOutcome::Held => self.say(
                "The block is held: the document changed where you typed. Choose keep mine, take theirs or keep both.",
                Tone::Warn,
            ),
            CommitOutcome::Failed(e) => {
                let note = format!("The block was not written back and stays open: {}", self.edit_error(&e));
                self.say(note, Tone::Error);
            }
            CommitOutcome::Nothing
            | CommitOutcome::Unchanged { .. }
            | CommitOutcome::Written { .. } => {}
        }
    }

    // ---- pointer ----------------------------------------------------------

    pub(super) fn on_pointer(&mut self, p: PanelPointer, cx: &mut Ctx) {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        if !matches!(self.phase, Phase::Ready(_)) {
            if matches!(p.kind, PointerKind::Down(Button::Left))
                && let Some(choice) = self.message_button_at(area, p.x, p.y)
            {
                self.choose(choice, cx);
            }
            return;
        }
        let Some(frame) = self.frame(area) else {
            return;
        };
        let inside = |r: Rect| {
            p.x >= i32::from(r.x)
                && p.x < i32::from(r.x + r.width)
                && p.y >= i32::from(r.y)
                && p.y < i32::from(r.y + r.height)
        };
        let mode = match self.doc() {
            Some(d) => self.shown(d).mode,
            None => return,
        };
        let source = self.source_rect(&frame, mode);
        let to_text = PanelPointer {
            x: p.x - i32::from(source.x),
            y: p.y - i32::from(source.y),
            ..p
        };
        let Some(d) = self.doc_mut() else { return };
        match p.kind {
            PointerKind::Down(Button::Left) => {
                if frame.bar.is_some_and(inside) {
                    if let Some(choice) = self.bar_button_at(&frame, p.x, p.y) {
                        self.choose(choice, cx);
                    }
                } else if frame.strip.is_some_and(inside) {
                    if let Some(choice) = self.strip_button_at(&frame, p.x, p.y) {
                        self.choose(choice, cx);
                    }
                } else if matches!(mode, MarkdownMode::Source | MarkdownMode::Split)
                    && inside(source)
                {
                    let reaction = d.md.get_mut().apply_local(|s| d.source.pointer(s, to_text));
                    self.settle(reaction);
                }
            }
            PointerKind::Wheel { dy, .. } => {
                if !inside(frame.text) {
                    return;
                }
                match mode {
                    // The caret goes with the view in Split, so that drawing
                    // the source does not pull it back to the caret.
                    MarkdownMode::Source => {
                        d.md.get_mut().apply_local(|s| d.source.pointer(s, to_text));
                    }
                    _ => {
                        d.md.get_mut().scroll_by(isize::from(dy));
                    }
                }
            }
            // A drag is the widget's while the press is held, wherever the
            // pointer is; with no drag a move is nobody's.
            PointerKind::Move | PointerKind::Up(_) => {
                if d.source.dragging() {
                    d.md.get_mut().apply_local(|s| d.source.pointer(s, to_text));
                }
            }
            PointerKind::Down(_) => {}
        }
    }

    // ---- going to a place -------------------------------------------------

    /// Move the caret to the scalar offset `at` of the text and show it: the
    /// source mode scrolls to it, Visual opens the block it is in with the
    /// caret there, Preview scrolls to the block.
    pub(super) fn go_to(&mut self, at: usize) {
        self.go_to_with(at, true);
    }

    /// [`go_to`](Self::go_to); `open` lets Visual open the block. A closed
    /// Visual reading the document only scrolls.
    fn go_to_with(&mut self, at: usize, open: bool) {
        let mode = match self.doc() {
            Some(d) => self.shown(d).mode,
            None => return,
        };
        let mut note = None;
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let at = at.min(md.session().len());
        md.apply_local(|s| s.set_selection(at, at));
        match mode {
            MarkdownMode::Source | MarkdownMode::Split => {
                md.apply_local(|s| d.source.reveal(s));
            }
            MarkdownMode::Visual if open => {
                let outcome = md.open_at_cursor();
                if let Some(range) = md.open_range() {
                    let start = md
                        .session()
                        .coords()
                        .to_scalar(range.start, Unit::Utf8, Snap::Backward)
                        .unwrap_or(0);
                    let inside = at.saturating_sub(start);
                    if let Some(s) = md.block_session() {
                        let inside = inside.min(s.len());
                        s.set_selection(inside, inside);
                    }
                }
                note = Some(outcome);
            }
            MarkdownMode::Visual | MarkdownMode::Preview => scroll_to_block(md),
        }
        if let Some(outcome) = note {
            self.committed(outcome);
        }
    }

    /// Go to the start of block `index` (clamped to the last).
    fn go_block_to(&mut self, index: usize) {
        let Some(d) = self.doc_mut() else { return };
        let (_, blocks) = d.block_position();
        let Some(block) = blocks.get(index.min(blocks.len().saturating_sub(1))) else {
            return;
        };
        let start = block.range.start;
        let (open, scalar) = {
            let md = d.md.get_mut();
            let scalar = md
                .session()
                .coords()
                .to_scalar(start, Unit::Utf8, Snap::Backward)
                .unwrap_or(0);
            (md.open_range().is_some(), scalar)
        };
        self.go_to_with(scalar, open);
    }

    fn step_blocks(&mut self, delta: isize) {
        let Some(d) = self.doc_mut() else { return };
        let (here, blocks) = d.block_position();
        if blocks.is_empty() {
            self.say("There are no blocks.", Tone::Info);
            return;
        }
        let from = here.map_or(0, |i| i as isize);
        let target = (from + delta).clamp(0, blocks.len() as isize - 1) as usize;
        self.go_block_to(target);
    }

    // ---- choices ----------------------------------------------------------

    pub(super) fn choose(&mut self, choice: Choice, cx: &mut Ctx) {
        if !matches!(self.phase, Phase::Ready(_)) {
            match choice {
                Choice::Retry if self.can_retry() => {
                    self.phase = Phase::Waiting;
                    self.tick(cx);
                }
                Choice::Close => cx.close_self(),
                _ => {}
            }
            return;
        }
        if choice == Choice::Close {
            cx.close_self();
            return;
        }
        if let Some(reason) = self.unavailable(choice) {
            // Esc with nothing to dismiss is not a request.
            // Nor is the chord for the mode already shown: it does nothing.
            if choice != Choice::Dismiss && choice != Choice::CloseBlock && choice.mode().is_none()
            {
                let title = choice.descriptor().title;
                self.say(format!("{title}: {reason}"), Tone::Warn);
            }
            return;
        }
        if let Some(mode) = choice.mode() {
            self.switch(mode);
            return;
        }
        match choice {
            Choice::Save => self.save(),
            Choice::ToggleCheckbox => self.toggle_checkbox(),
            Choice::OpenBlock => self.open_block(),
            Choice::CloseBlock => {
                if let Some(d) = self.doc_mut() {
                    let outcome = d.md.get_mut().commit_block();
                    self.committed(outcome);
                }
            }
            Choice::NextBlock => self.step_blocks(1),
            Choice::PreviousBlock => self.step_blocks(-1),
            Choice::OpenLink => self.open_link(cx),
            Choice::NextLink => self.step_links(true),
            Choice::PreviousLink => self.step_links(false),
            Choice::KeepMine => self.resolve(Resolution::KeepMine, cx),
            // Recovered edits that were not placed are chosen about with the
            // conflict's words, and settled as recovered ones.
            Choice::TakeTheirs if self.unplaced() => self.settle_recovered(false, cx),
            Choice::KeepBoth if self.unplaced() => self.settle_recovered(true, cx),
            Choice::TakeTheirs => self.resolve(Resolution::TakeTheirs, cx),
            Choice::KeepBoth => self.resolve(Resolution::KeepBoth, cx),
            Choice::CopyMine | Choice::CopyRecovered => {
                let Some(d) = self.doc_mut() else { return };
                let md = d.md.get_mut();
                let text = match (
                    &d.sync.restored,
                    md.block_conflict(),
                    d.sync.recoverable.clone(),
                ) {
                    (Some(r), _, _) => r.text.clone(),
                    (None, Some(k), _) => k.mine,
                    (None, None, Some(set_aside)) => set_aside,
                    (None, None, None) => md.text(),
                };
                self.write_clipboard(text, Clip::Copy, cx);
            }
            Choice::Resend => {
                if let Some(d) = self.doc_mut()
                    && let Some(u) = d.sync.unknown.take()
                {
                    d.sync.inflight = None;
                    let _ = d.md.get_mut().requeue(&u.op);
                    d.notice("Sending the edit again under its own id.", Tone::Info);
                }
            }
            Choice::KeepRecovered => self.settle_recovered(true, cx),
            Choice::DiscardRecovered => self.settle_recovered(false, cx),
            Choice::KeepDisk => self.reconcile(ReconcileKeep::Disk, cx),
            Choice::KeepAuthority => self.reconcile(ReconcileKeep::Authority, cx),
            Choice::Dismiss => {
                if let Some(d) = self.doc_mut() {
                    d.notice = None;
                    d.sync.recoverable = None;
                    d.link = None;
                }
            }
            Choice::Visual
            | Choice::Source
            | Choice::Split
            | Choice::Preview
            | Choice::Retry
            | Choice::Close => {}
        }
    }

    fn can_retry(&self) -> bool {
        matches!(&self.phase, Phase::Failed(p) if p.can_retry)
    }

    /// Switch mode. The open block is written back first and what was typed in
    /// it is never lost: a held block stays open in the new mode, and a write
    /// the session refuses keeps the mode where it was.
    fn switch(&mut self, mode: MarkdownMode) {
        let Some(d) = self.doc_mut() else { return };
        let outcome = d.md.get_mut().set_mode(mode);
        // The model made the session read-only for Preview and writable
        // otherwise; the owner's say comes on top.
        d.sync_read_only();
        let failed = matches!(outcome, CommitOutcome::Failed(_));
        self.committed(outcome);
        if failed {
            return;
        }
        if let Some(d) = self.doc_mut() {
            d.notice = None;
        }
    }

    fn open_block(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        if md.mode() != MarkdownMode::Visual {
            self.switch(MarkdownMode::Visual);
            return;
        }
        let outcome = md.open_at_cursor();
        self.committed(outcome);
    }

    fn save(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        // What is typed in an open block is part of the document the person
        // is saving: write it back, then save once the owner has it.
        if d.block_dirty() {
            let outcome = d.md.get_mut().commit_block();
            let stop = matches!(outcome, CommitOutcome::Held | CommitOutcome::Failed(_));
            self.committed(outcome);
            if stop {
                return;
            }
        }
        let Some(d) = self.doc_mut() else { return };
        // The save is of the revision the owner has accepted; it goes now, or
        // once the edits typed so far are accepted.
        d.sync.want_save();
        if d.md.get_mut().session().has_pending() {
            d.notice(
                "Saving as soon as the owner has accepted the edits.",
                Tone::Info,
            );
        }
    }

    /// Flip the box on the caret's line, or else the first one of the block
    /// the caret is in, as one ordinary edit that goes to the owner.
    fn toggle_checkbox(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        if d.block_dirty() {
            let outcome = d.md.get_mut().commit_block();
            let stop = matches!(outcome, CommitOutcome::Held | CommitOutcome::Failed(_));
            self.committed(outcome);
            if stop {
                return;
            }
        }
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let text = md.text();
        let tasks = links::tasks(&text);
        let at = md.cursor_byte().min(text.len());
        let line = (
            text[..at].rfind('\n').map_or(0, |i| i + 1),
            text[at..].find('\n').map_or(text.len(), |i| at + i),
        );
        let block = md
            .block_at(at)
            .and_then(|i| md.blocks().get(i).map(|b| b.range.clone()));
        let target = tasks
            .iter()
            .find(|t| t.mark >= line.0 && t.mark < line.1)
            .or_else(|| {
                block
                    .as_ref()
                    .and_then(|r| tasks.iter().find(|t| r.contains(&t.mark)))
            })
            .copied();
        let Some(task) = target else {
            d.notice("There is no checkbox here.", Tone::Info);
            return;
        };
        let scalar = md
            .session()
            .coords()
            .to_scalar(task.mark, Unit::Utf8, Snap::Backward)
            .unwrap_or(0);
        let mark = if task.checked { " " } else { "x" };
        let result = md.apply_local(|s| {
            let (anchor, head) = (s.anchor(), s.cursor());
            s.break_undo_group();
            s.set_selection(scalar, scalar + 1);
            let r = s.insert_text(mark);
            // One scalar for one scalar: the person's selection is where it was.
            s.set_selection(anchor, head);
            s.break_undo_group();
            r
        });
        if let Err(e) = result {
            let note = self.edit_error(&e);
            self.say(note, Tone::Warn);
        }
    }

    /// The link the caret is in, else the one Tab selected: its address.
    fn current_link(&mut self) -> Option<String> {
        let d = self.doc_mut()?;
        let md = d.md.get_mut();
        let (text, at) = match md.block_session() {
            Some(s) => {
                let text = s.text();
                let at = s.coords().from_scalar(s.cursor(), Unit::Utf8).unwrap_or(0);
                (text, at)
            }
            None => (md.text(), md.cursor_byte()),
        };
        let found = links::links(&text);
        if let Some(l) = found.iter().find(|l| l.range.contains(&at)) {
            return Some(l.url.clone());
        }
        let all = links::links(&md.text());
        d.link.and_then(|i| all.get(i)).map(|l| l.url.clone())
    }

    /// Open the link: a workspace path goes to the root as the core's open, a
    /// remote address is shown and nothing else happens, a place in this
    /// document is gone to.
    fn open_link(&mut self, cx: &mut Ctx) {
        let Some(url) = self.current_link() else {
            self.say("The caret is not in a link; Tab selects one.", Tone::Info);
            return;
        };
        match links::classify(&self.path, &url) {
            Target::Workspace { path, .. } => {
                cx.open(OpenTarget::File {
                    workspace: self.workspace.clone(),
                    path: path.clone(),
                });
                self.say(format!("Opening {path}."), Tone::Info);
            }
            Target::Remote(url) => self.say(
                format!("{url} is a remote address: nothing is opened or fetched automatically."),
                Tone::Warn,
            ),
            Target::Fragment(fragment) => {
                let found = self.heading_offset(&fragment);
                match found {
                    Some(at) => self.go_to(at),
                    None => self.say(
                        format!("There is no heading \"#{fragment}\" in this document."),
                        Tone::Warn,
                    ),
                }
            }
            Target::Refused(why) => self.say(why, Tone::Warn),
        }
    }

    fn heading_offset(&mut self, fragment: &str) -> Option<usize> {
        let d = self.doc_mut()?;
        let md = d.md.get_mut();
        let text = md.text();
        let byte = links::heading_start(&text, fragment)?;
        md.session()
            .coords()
            .to_scalar(byte, Unit::Utf8, Snap::Backward)
    }

    fn step_links(&mut self, forward: bool) {
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let found = links::links(&md.text());
        if found.is_empty() {
            d.link = None;
            d.notice("There are no links.", Tone::Info);
            return;
        }
        let next = match (d.link, forward) {
            (None, true) => {
                // The first link at or after the caret.
                let at = md.cursor_byte();
                found.iter().position(|l| l.range.end > at).unwrap_or(0)
            }
            (None, false) => found.len() - 1,
            (Some(i), true) => (i + 1) % found.len(),
            (Some(i), false) => (i + found.len() - 1) % found.len(),
        };
        d.link = Some(next);
        let byte = found[next].range.start;
        let scalar = md
            .session()
            .coords()
            .to_scalar(byte, Unit::Utf8, Snap::Backward)
            .unwrap_or(0);
        self.go_to_with(scalar, false);
    }

    // ---- the clipboard ----------------------------------------------------

    /// Through the core's effects only: the panel keeps no buffer of its own.
    fn clipboard(&mut self, what: Clipboard, block: bool, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let (read_only, selected) = if block {
            match md.block_session() {
                Some(s) => (s.config().read_only, s.selected_text().zip(s.selection())),
                None => return,
            }
        } else {
            (
                md.session().config().read_only,
                md.session().selected_text().zip(md.session().selection()),
            )
        };
        match what {
            Clipboard::Copy | Clipboard::Cut => {
                let Some((text, selection)) = selected else {
                    d.notice("Nothing is selected.", Tone::Info);
                    return;
                };
                if what == Clipboard::Cut && read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                let task = if what == Clipboard::Cut {
                    Clip::Cut {
                        text: text.clone(),
                        selection,
                        block,
                    }
                } else {
                    Clip::Copy
                };
                self.write_clipboard(text, task, cx);
            }
            Clipboard::Paste => {
                if read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                if let Err(e) = self.emit_clip(cx, EffectBody::ClipboardRead, Clip::Paste { block })
                {
                    self.say(emit_notice(e), Tone::Warn);
                }
            }
        }
    }

    pub(super) fn relayout(&mut self) {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        let Some(frame) = self.frame(area) else {
            return;
        };
        let mode = match self.doc() {
            Some(d) => self.shown(d).mode,
            None => return,
        };
        let source = self.source_rect(&frame, mode);
        let Some(d) = self.doc_mut() else { return };
        let md = d.md.get_mut();
        let size = (source.width, source.height);
        if d.source.size() != size {
            let first = d.source.size() == (0, 0);
            md.apply_local(|s| {
                d.source.resize(s, size.0, size.1);
                // Only the first layout shows the caret: a later one keeps
                // the scroll anchor the person left.
                if first {
                    d.source.reveal(s);
                }
            });
        }
        // The block's text sits one cell in, beside its bar.
        let block = (frame.text.width.saturating_sub(1), frame.text.height);
        if let Some(s) = md.block_session()
            && d.block.size() != block
        {
            d.block.resize(s, block.0, block.1);
        }
    }
}

/// Scroll a reading view so the block the caret is in is the first row.
fn scroll_to_block(md: &mut MarkdownDoc) {
    let at = md.cursor_byte();
    let Some(block) = md.block_at(at) else {
        return;
    };
    let mut view = md.view_state();
    view.anchor = Anchor { block, row: 0 };
    md.restore_view(&view);
}
