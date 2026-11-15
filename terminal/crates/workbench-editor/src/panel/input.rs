//! Keys, text, the pointer, and the actions they start.

use keybinds::{Key, KeyInput, Mods};
use ratatui::layout::Rect;
use theorem_workbench_core::effect::ReconcileKeep;
use theorem_workbench_core::{Button, Ctx, PanelPointer, PointerKind};
use theorem_workbench_text::{EditError, EditSession, LocalEdit, Resolution};

use super::language::LIST_ROWS;
use super::{Clip, EditorPanel, Phase, Tone};
use crate::actions::Choice;
use crate::field::{Event, Field};
use crate::widget::{Clipboard, Reaction};

/// The chord a key is, when it is one. Alt and a letter belong to the editor
/// only for the letters it uses: any other Alt combination is the widget's.
fn chord(key: &KeyInput) -> Option<Choice> {
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
            'f' => Some(Choice::Find),
            'h' => Some(Choice::FindReplace),
            ' ' => Some(Choice::Complete),
            _ => None,
        },
        Key::F3 if mods.contains(Mods::SHIFT) => Some(Choice::FindPrevious),
        Key::F12 if mods.contains(Mods::SHIFT) => Some(Choice::References),
        Key::F12 => Some(Choice::Definition),
        Key::F3 => Some(Choice::FindNext),
        Key::F2 => Some(Choice::Rename),
        Key::Char(c) if alt && c.is_ascii_alphabetic() => match c.to_ascii_lowercase() {
            'f' if c == 'F' || mods.contains(Mods::SHIFT) => Some(Choice::Format),
            'a' => Some(Choice::ApplyPlan),
            'h' => Some(Choice::Hover),
            'x' => Some(Choice::Check),
            'm' => Some(Choice::KeepMine),
            't' => Some(Choice::TakeTheirs),
            'b' => Some(Choice::KeepBoth),
            'y' => Some(Choice::CopyMine),
            'j' => Some(Choice::KeepRecovered),
            'g' => Some(Choice::DiscardRecovered),
            'r' => Some(Choice::Resend),
            'd' => Some(Choice::KeepDisk),
            'k' => Some(Choice::KeepAuthority),
            _ => None,
        },
        _ => None,
    }
}

impl EditorPanel {
    pub(super) fn on_key(&mut self, key: KeyInput, cx: &mut Ctx) {
        if !matches!(self.phase, Phase::Ready(_)) {
            if self.naming_idle() {
                self.naming_key(&key, cx);
                return;
            }
            match key.key() {
                Key::Enter => self.choose(Choice::Retry, cx),
                Key::Esc => self.choose(Choice::Close, cx),
                _ => {}
            }
            return;
        }

        // The name of a new page is modal like the rename name.
        if self.naming.is_some() && self.naming_key(&key, cx) {
            return;
        }

        if self.popup_key(&key, cx) {
            return;
        }

        // The rename name is modal: everything goes to it until it ends.
        if let Some(d) = self.doc_mut()
            && let Some(field) = d.rename.as_mut()
        {
            match field.key(&key) {
                Event::Enter => {
                    let name = field.value().trim().to_owned();
                    d.rename = None;
                    if !name.is_empty() {
                        self.send_rename(name, cx);
                    }
                }
                Event::Escape => d.rename = None,
                Event::Edited | Event::Ignored => {}
            }
            return;
        }

        if let Some(choice) = chord(&key) {
            self.choose(choice, cx);
            return;
        }

        let Some(d) = self.doc_mut() else { return };
        let mods = key.mods();
        if d.find.is_open() && mods.contains(Mods::ALT) && matches!(key.key(), Key::Char('c' | 'C'))
        {
            d.find.toggle_case();
            return;
        }

        if d.in_find && d.find.is_replacing() {
            if mods.contains(Mods::ALT) && key.key() == Key::Enter {
                self.choose(Choice::ReplaceAll, cx);
                return;
            }
            if key.key() == Key::Tab {
                d.in_replace = !d.in_replace;
                return;
            }
            if d.in_replace {
                match d.find.replacement.key(&key) {
                    Event::Enter => self.choose(Choice::Replace, cx),
                    Event::Escape => {
                        d.find.close();
                        d.in_find = false;
                        d.in_replace = false;
                    }
                    Event::Edited | Event::Ignored => {}
                }
                return;
            }
        }

        if d.in_find {
            match d.find.field.key(&key) {
                Event::Enter => {
                    let forward = !mods.contains(Mods::SHIFT);
                    self.choose(
                        if forward {
                            Choice::FindNext
                        } else {
                            Choice::FindPrevious
                        },
                        cx,
                    );
                    return;
                }
                Event::Escape => {
                    d.find.close();
                    d.in_find = false;
                    d.in_replace = false;
                    return;
                }
                Event::Edited => {
                    self.land_on_first_match();
                    return;
                }
                Event::Ignored => {}
            }
        }

        if key.key() == Key::Esc {
            self.choose(Choice::Dismiss, cx);
            return;
        }

        let Some(d) = self.doc_mut() else { return };
        let reaction = d.view.key(&mut d.session, &key);
        if let Some(c) = self.settle(reaction) {
            self.clipboard(c, cx);
        }
    }

    pub(super) fn on_text(&mut self, text: &str) {
        if self.naming_text(text) {
            return;
        }
        let Some(d) = self.doc_mut() else { return };
        d.popup = None;
        if d.in_find && d.in_replace {
            d.find.replacement.text(text);
            return;
        }
        if let Some(field) = d.rename.as_mut() {
            field.text(text);
            return;
        }
        if d.in_find {
            d.find.field.text(text);
            self.land_on_first_match();
            return;
        }
        let reaction = d.view.text(&mut d.session, text);
        self.settle(reaction);
    }

    pub(super) fn on_paste(&mut self, text: &str) {
        if self.naming_text(text) {
            return;
        }
        let Some(d) = self.doc_mut() else { return };
        d.popup = None;
        if d.in_find && d.in_replace {
            d.find.replacement.text(text.lines().next().unwrap_or(""));
            return;
        }
        if let Some(field) = d.rename.as_mut() {
            field.text(text.lines().next().unwrap_or(""));
            return;
        }
        if d.in_find {
            d.find.field.text(text.lines().next().unwrap_or(""));
            self.land_on_first_match();
            return;
        }
        let reaction = d.view.paste(&mut d.session, text);
        self.settle(reaction);
    }

    /// What an input did, in the panel's terms. A clipboard request comes back
    /// for the caller, which has the context to send it.
    fn settle(&mut self, reaction: Reaction) -> Option<Clipboard> {
        let Reaction {
            edited,
            error,
            clipboard,
            ..
        } = reaction;
        if edited && let Some(d) = self.doc_mut() {
            d.touch();
        }
        if let Some(e) = error {
            let note = self.edit_error(&e);
            self.say(note, Tone::Warn);
        }
        clipboard
    }

    pub(super) fn edit_error(&self, error: &EditError) -> String {
        match error {
            EditError::ReadOnly => {
                let why = self
                    .doc()
                    .and_then(|d| d.sync.read_only.clone())
                    .unwrap_or_else(|| "the owner does not allow edits here".to_owned());
                format!("Read-only: {why}")
            }
            other => other.to_string(),
        }
    }

    /// While the query is typed, the selection follows the first match at or
    /// after where it started.
    fn land_on_first_match(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        let version = d.version;
        d.find.refresh(&d.session, version);
        let from = d.session.selection().map_or(d.session.cursor(), |s| s.0);
        if let Some((a, b)) = d.find.first_from(from) {
            d.session.set_selection(a, b);
            d.view.reveal(&mut d.session);
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
        let to_text = PanelPointer {
            x: p.x - i32::from(frame.text.x),
            y: p.y - i32::from(frame.text.y),
            ..p
        };
        let find_button = self.find_button_at(&frame, p.x, p.y);
        let Some(d) = self.doc_mut() else { return };
        // A popup is over the text: its rows take the pointer first.
        if let Some(popup) = d.popup.as_mut() {
            let caret = d.view.caret_cell(&d.session, frame.text);
            let place = super::chrome::popup_place(popup, caret, frame.text);
            let over = place.filter(|(r, _)| inside(*r));
            match (p.kind, over) {
                (PointerKind::Wheel { dy, .. }, Some(_)) => {
                    popup.scroll(isize::from(dy.signum()) * 3, usize::from(frame.text.height));
                    return;
                }
                (PointerKind::Down(Button::Left), Some((r, first))) => {
                    if popup.selected().is_some() {
                        popup.select(first + usize::try_from(p.y - i32::from(r.y)).unwrap_or(0));
                        self.accept_popup(cx);
                    }
                    return;
                }
                // A press anywhere else puts the popup away and goes on.
                (PointerKind::Down(_), None) => d.popup = None,
                _ => {}
            }
        }
        match p.kind {
            PointerKind::Down(Button::Left) => {
                if frame.find.is_some_and(inside) {
                    if let Some(choice) = find_button {
                        self.choose(choice, cx);
                        return;
                    }
                    d.in_find = true;
                    d.in_replace =
                        d.find.is_replacing() && frame.find.is_some_and(|r| p.y > i32::from(r.y));
                } else if frame.strip.is_some_and(inside) {
                    if let Some(choice) = self.strip_button_at(&frame, p.x, p.y) {
                        self.choose(choice, cx);
                    }
                } else if inside(frame.text) {
                    d.in_find = false;
                    let reaction = d.view.pointer(&mut d.session, to_text);
                    self.settle(reaction);
                }
            }
            PointerKind::Wheel { .. } => {
                if inside(frame.text) {
                    d.view.pointer(&mut d.session, to_text);
                }
            }
            // A drag is the widget's while the press is held, wherever the
            // pointer is; with no drag a move is nobody's.
            PointerKind::Move | PointerKind::Up(_) => {
                if d.view.dragging() {
                    d.view.pointer(&mut d.session, to_text);
                }
            }
            PointerKind::Down(_) => {}
        }
    }

    // ---- choices ----------------------------------------------------------

    pub(super) fn choose(&mut self, choice: Choice, cx: &mut Ctx) {
        if !matches!(self.phase, Phase::Ready(_)) {
            match choice {
                Choice::Retry if self.can_retry() => {
                    self.phase = Phase::Waiting;
                    self.tick(cx);
                }
                Choice::Create => {
                    if self.naming.is_none() {
                        self.begin_naming();
                    }
                    self.submit_naming(cx);
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
        if choice == Choice::Create {
            if self.naming.is_none() {
                self.begin_naming();
            } else {
                self.submit_naming(cx);
            }
            return;
        }
        if let Some(reason) = self.unavailable(choice) {
            // Esc on a clean editor is not a request.
            if choice != Choice::Dismiss {
                let title = choice.descriptor().title;
                self.say(format!("{title}: {reason}"), Tone::Warn);
            }
            return;
        }
        match choice {
            Choice::Save => self.save(),
            Choice::Undo => self.local(|s| s.undo()),
            Choice::Redo => self.local(|s| s.redo()),
            Choice::Find => {
                if let Some(d) = self.doc_mut() {
                    let seed = d.session.selected_text();
                    d.find.open(seed);
                    d.in_find = true;
                    let version = d.version;
                    d.find.refresh(&d.session, version);
                }
            }
            Choice::FindReplace => {
                if let Some(d) = self.doc_mut() {
                    let seed = d.session.selected_text();
                    d.find.open_replacing(seed);
                    d.in_find = true;
                    d.in_replace = false;
                    let version = d.version;
                    d.find.refresh(&d.session, version);
                }
            }
            Choice::Replace => self.replace(false),
            Choice::ReplaceAll => self.replace(true),
            Choice::Hover | Choice::Complete | Choice::Definition | Choice::References => {
                self.ask(choice, cx);
            }
            Choice::Check => self.check(cx, true),
            Choice::FindNext => self.step(true),
            Choice::FindPrevious => self.step(false),
            Choice::Rename => {
                if let Some(d) = self.doc_mut() {
                    let seed = d.view.seed(&d.session).unwrap_or_default();
                    d.rename = Some(Field::with_value(&seed));
                }
            }
            Choice::Format => self.send_format(cx),
            Choice::ApplyPlan => self.apply_plan(cx),
            Choice::KeepMine => self.resolve(Resolution::KeepMine, cx),
            // Recovered edits that were not placed are chosen about with the
            // conflict's words, and settled as recovered ones.
            Choice::TakeTheirs if self.unplaced() => self.settle_recovered(false, cx),
            Choice::KeepBoth if self.unplaced() => self.settle_recovered(true, cx),
            Choice::TakeTheirs => self.resolve(Resolution::TakeTheirs, cx),
            Choice::KeepBoth => self.resolve(Resolution::KeepBoth, cx),
            Choice::KeepRecovered => self.settle_recovered(true, cx),
            Choice::DiscardRecovered => self.settle_recovered(false, cx),
            Choice::CopyMine | Choice::CopyRecovered => {
                let Some(d) = self.doc() else { return };
                let text = match &d.sync.restored {
                    Some(r) => r.text.clone(),
                    None => d
                        .sync
                        .recoverable
                        .clone()
                        .unwrap_or_else(|| d.session.text()),
                };
                self.write_clipboard(text, Clip::Copy, cx);
            }
            Choice::Resend => {
                if let Some(d) = self.doc_mut()
                    && let Some(u) = d.sync.unknown.take()
                {
                    d.sync.inflight = None;
                    let _ = d.session.requeue(&u.op);
                    d.notice("Sending the edit again under its own id.", Tone::Info);
                }
            }
            Choice::KeepDisk => self.reconcile(ReconcileKeep::Disk, cx),
            Choice::KeepAuthority => self.reconcile(ReconcileKeep::Authority, cx),
            Choice::Dismiss => {
                if let Some(d) = self.doc_mut() {
                    if d.popup.is_some() {
                        d.popup = None;
                    } else if d.find.is_open() {
                        d.find.close();
                        d.in_find = false;
                        d.in_replace = false;
                    } else {
                        d.notice = None;
                        d.sync.recoverable = None;
                        d.plan = None;
                    }
                }
            }
            Choice::Retry | Choice::Close | Choice::Create => {}
        }
    }

    fn can_retry(&self) -> bool {
        matches!(&self.phase, Phase::Failed(p) if p.can_retry)
    }

    fn save(&mut self) {
        let Some(d) = self.doc_mut() else { return };
        if d.session.has_pending() {
            // The save is of the revision the owner has accepted; the edits
            // typed so far are not in it until the owner says so.
            d.sync.want_save();
            d.notice(
                "Saving as soon as the owner has accepted the edits.",
                Tone::Info,
            );
        } else {
            // Sent by the pump that follows this message.
            d.sync.want_save();
        }
    }

    /// A local change to the text from outside the widget (undo, redo).
    fn local(&mut self, f: impl FnOnce(&mut EditSession) -> Result<Option<LocalEdit>, EditError>) {
        let Some(d) = self.doc_mut() else { return };
        match f(&mut d.session) {
            Ok(Some(_)) => {
                d.touch();
                d.view.reveal(&mut d.session);
            }
            Ok(None) => {}
            Err(e) => {
                let note = self.edit_error(&e);
                self.say(note, Tone::Warn);
            }
        }
    }

    /// Replace the match the caret is on, or the next one, and land on the
    /// match after it; or every match at once. Either is one ordinary edit, so
    /// one undo takes it back.
    fn replace(&mut self, all: bool) {
        let Some(d) = self.doc_mut() else { return };
        let version = d.version;
        d.find.refresh(&d.session, version);
        let with = d.find.replacement.value().to_owned();
        let ranges = d.find.ranges().to_vec();
        let target = if all {
            ranges.first().zip(ranges.last()).map(|(f, l)| (f.0, l.1))
        } else {
            d.find
                .current(&d.session)
                .map(|i| ranges[i])
                .or_else(|| d.find.first_from(d.session.cursor()))
        };
        let Some((start, end)) = target else {
            d.notice("There are no matches.", Tone::Info);
            return;
        };
        let text = if all {
            let rope = d.session.rope();
            let mut out = String::new();
            let mut at = start;
            for &(a, b) in &ranges {
                out.push_str(&rope.slice(at..a).to_string());
                out.push_str(&with);
                at = b;
            }
            out
        } else {
            with
        };
        d.session.break_undo_group();
        d.session.set_selection(start, end);
        let result = d.session.insert_text(&text);
        d.session.break_undo_group();
        match result {
            Ok(_) => {
                d.touch();
                let version = d.version;
                d.find.refresh(&d.session, version);
                if all {
                    d.notice(
                        format!(
                            "Replaced {} match{}.",
                            ranges.len(),
                            if ranges.len() == 1 { "" } else { "es" }
                        ),
                        Tone::Info,
                    );
                } else if let Some((a, b)) = d.find.first_from(d.session.cursor()) {
                    d.session.set_selection(a, b);
                }
                d.view.reveal(&mut d.session);
            }
            Err(e) => {
                let note = self.edit_error(&e);
                self.say(note, Tone::Warn);
            }
        }
    }

    /// A key while a popup is over the text. True when the popup took it; any
    /// other key closes the popup and goes on to do what it does.
    fn popup_key(&mut self, key: &KeyInput, cx: &mut Ctx) -> bool {
        let Some(d) = self.doc_mut() else {
            return false;
        };
        let Some(popup) = d.popup.as_mut() else {
            return false;
        };
        let list = popup.selected().is_some();
        match key.key() {
            Key::Esc => d.popup = None,
            Key::Down if list => popup.step(1),
            Key::Up if list => popup.step(-1),
            Key::PageDown if list => popup.step(LIST_ROWS as isize),
            Key::PageUp if list => popup.step(-(LIST_ROWS as isize)),
            Key::Enter | Key::Tab if list => self.accept_popup(cx),
            _ => {
                d.popup = None;
                return false;
            }
        }
        true
    }

    fn step(&mut self, forward: bool) {
        let Some(d) = self.doc_mut() else { return };
        let version = d.version;
        d.find.refresh(&d.session, version);
        if let Some((a, b)) = d.find.step(&d.session, forward) {
            d.session.set_selection(a, b);
            d.view.reveal(&mut d.session);
        }
    }

    // ---- the clipboard ----------------------------------------------------

    /// Through the core's effects only: the panel keeps no buffer of its own.
    fn clipboard(&mut self, what: Clipboard, cx: &mut Ctx) {
        let Some(d) = self.doc_mut() else { return };
        match what {
            Clipboard::Copy | Clipboard::Cut => {
                let (Some(text), Some(selection)) =
                    (d.session.selected_text(), d.session.selection())
                else {
                    d.notice("Nothing is selected.", Tone::Info);
                    return;
                };
                if what == Clipboard::Cut && d.session.config().read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                let task = if what == Clipboard::Cut {
                    Clip::Cut {
                        text: text.clone(),
                        selection,
                    }
                } else {
                    Clip::Copy
                };
                self.write_clipboard(text, task, cx);
            }
            Clipboard::Paste => {
                if d.session.config().read_only {
                    let note = self.edit_error(&EditError::ReadOnly);
                    self.say(note, Tone::Warn);
                    return;
                }
                if let Err(e) = self.emit_clip(
                    cx,
                    theorem_workbench_core::effect::EffectBody::ClipboardRead,
                    Clip::Paste,
                ) {
                    self.say(super::flow::emit_notice(e), Tone::Warn);
                }
            }
        }
    }

    pub(super) fn relayout(&mut self) {
        let area = Rect::new(0, 0, self.body.0, self.body.1);
        let Some(frame) = self.frame(area) else {
            return;
        };
        if let Some(d) = self.doc_mut() {
            let size = (frame.text.width, frame.text.height);
            if d.view.size() != size {
                d.view.resize(&mut d.session, size.0, size.1);
                d.view.reveal(&mut d.session);
            }
        }
    }
}
