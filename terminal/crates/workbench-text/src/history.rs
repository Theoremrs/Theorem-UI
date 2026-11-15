//! Undo and redo as stacks of operations.
//!
//! An undo entry is the inverse of a local edit and applies to the current
//! text. Typing is grouped: consecutive inserts of the same character class
//! that touch each other, and consecutive backspaces or forward deletes that
//! touch each other, share one entry. A change from the owner never becomes an
//! entry; instead every entry is transformed past it so it still applies.

use operational_transform::OperationSeq;

const MAX_ENTRIES: usize = 1000;

/// What an edit was, for grouping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Insert,
    Backspace,
    DeleteForward,
    /// Pastes, cuts, word deletes, newlines, replacements: never grouped.
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Class {
    Word,
    Space,
    Other,
}

pub(crate) fn class_of(text: &str) -> Class {
    match text.chars().last() {
        Some(c) if c.is_alphanumeric() || c == '_' => Class::Word,
        Some(c) if c.is_whitespace() => Class::Space,
        _ => Class::Other,
    }
}

/// How one edit sits in the text, in scalars: it replaced `[start, end)` with `inserted` scalars.
#[derive(Clone, Copy, Debug)]
pub(crate) struct EditShape {
    pub kind: Kind,
    pub start: usize,
    pub end: usize,
    pub inserted: usize,
    pub class: Class,
    pub has_newline: bool,
}

#[derive(Clone, Copy, Debug)]
struct Group {
    kind: Kind,
    /// Where the next edit of this kind must touch for the group to continue.
    next: usize,
    class: Class,
}

#[derive(Default)]
pub(crate) struct History {
    undo: Vec<OperationSeq>,
    redo: Vec<OperationSeq>,
    group: Option<Group>,
}

impl History {
    /// Record the inverse of a fresh local edit. Clears the redo stack.
    pub fn record(&mut self, inverse: OperationSeq, shape: EditShape) {
        self.redo.clear();
        let joins = match (&self.group, shape.kind) {
            (Some(g), Kind::Insert) => {
                g.kind == Kind::Insert
                    && g.next == shape.start
                    && g.class == shape.class
                    && !shape.has_newline
            }
            (Some(g), Kind::Backspace) => g.kind == Kind::Backspace && g.next == shape.end,
            (Some(g), Kind::DeleteForward) => {
                g.kind == Kind::DeleteForward && g.next == shape.start
            }
            _ => false,
        };
        let merged = joins
            && self
                .undo
                .last()
                .and_then(|top| inverse.compose(top).ok())
                .map(|c| {
                    *self.undo.last_mut().expect("top exists") = c;
                })
                .is_some();
        if !merged {
            self.undo.push(inverse);
            if self.undo.len() > MAX_ENTRIES {
                self.undo.remove(0);
            }
        }
        self.group = match shape.kind {
            Kind::Insert if !shape.has_newline => Some(Group {
                kind: Kind::Insert,
                next: shape.start + shape.inserted,
                class: shape.class,
            }),
            Kind::Backspace => Some(Group {
                kind: Kind::Backspace,
                next: shape.start,
                class: Class::Other,
            }),
            Kind::DeleteForward => Some(Group {
                kind: Kind::DeleteForward,
                next: shape.start,
                class: Class::Other,
            }),
            _ => None,
        };
    }

    /// End the open typing group; the next edit starts a new entry.
    pub fn close_group(&mut self) {
        self.group = None;
    }

    pub fn pop_undo(&mut self) -> Option<OperationSeq> {
        self.group = None;
        self.undo.pop()
    }

    pub fn pop_redo(&mut self) -> Option<OperationSeq> {
        self.group = None;
        self.redo.pop()
    }

    pub fn push_redo(&mut self, op: OperationSeq) {
        self.redo.push(op);
    }

    /// An undo entry made by a redo: does not clear the redo stack.
    pub fn push_undo(&mut self, op: OperationSeq) {
        self.undo.push(op);
    }

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.group = None;
    }

    /// Keep every entry applicable after `remote` changed the current text.
    /// The remote change is not an entry and cannot be undone from here.
    pub fn transform_past(&mut self, remote: &OperationSeq) {
        self.group = None;
        transform_stack(&mut self.undo, remote);
        transform_stack(&mut self.redo, remote);
    }
}

/// Entries are chained: the top applies to the current text, the next to the
/// text the top produces, and so on. `remote` applies to the current text.
fn transform_stack(stack: &mut Vec<OperationSeq>, remote: &OperationSeq) {
    let mut carried = remote.clone();
    for entry in stack.iter_mut().rev() {
        match carried.transform(entry) {
            Ok((after_entry, entry_after_remote)) => {
                *entry = entry_after_remote;
                carried = after_entry;
            }
            Err(_) => {
                // Lengths no longer chain; an unusable stack is dropped rather than misapplied.
                stack.clear();
                return;
            }
        }
    }
    stack.retain(|e| !e.is_noop());
}
