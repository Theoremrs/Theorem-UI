//! Bounded queues, one per source, each with a stated overflow policy (R41).
//!
//! Semantic updates have no queue: the tree is state, published as a diff
//! against the last one sent, so a burst of changes between frames cannot lose
//! one (see `semantics`).

use std::collections::VecDeque;

/// What a full queue does with the next item.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overflow {
    /// Merge the new item into the last one if they join; otherwise signal
    /// back-pressure. Loses nothing.
    Coalesce,
    /// Drop the oldest items to make room and leave a visible [`Popped::Gap`]
    /// so the consumer can resnapshot. Used where the source can replay.
    DropOldest,
    /// Refuse the item and hand it back, so the producer slows or resyncs.
    Backpressure,
}

/// What the queue needs to know about an item.
pub trait Item: Sized {
    /// Size against the queue's capacity: bytes for streams, 1 for events.
    fn weight(&self) -> usize;

    /// Join `next` onto `self` when they are contiguous. Give `next` back when
    /// they are not.
    fn merge(&mut self, next: Self) -> Result<(), Self> {
        Err(next)
    }
}

/// The result of offering an item.
#[derive(Debug, PartialEq, Eq)]
pub enum Push<T> {
    Queued,
    /// Joined onto the last queued item.
    Merged,
    /// Queued after dropping older items; the gap is reported on pop.
    QueuedAfterDrop {
        dropped: usize,
    },
    /// The queue is full and the policy refuses. The item is handed back
    /// untouched, never lost.
    Full(T),
}

/// What comes out of the queue.
#[derive(Debug, PartialEq, Eq)]
pub enum Popped<T> {
    Item(T),
    /// Items were dropped here. The next item is not contiguous with the last.
    Gap {
        items: u64,
        weight: u64,
    },
}

/// A queue bounded in items and in weight. Either bound can be the one that
/// fills; the overflow policy answers both the same way.
#[derive(Debug)]
pub struct BoundedQueue<T: Item> {
    max_items: usize,
    max_weight: usize,
    overflow: Overflow,
    items: VecDeque<T>,
    weight: usize,
    gap: Option<(u64, u64)>,
}

impl<T: Item> BoundedQueue<T> {
    pub fn new(max_items: usize, max_weight: usize, overflow: Overflow) -> Self {
        Self {
            max_items,
            max_weight,
            overflow,
            items: VecDeque::new(),
            weight: 0,
            gap: None,
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty() && self.gap.is_none()
    }

    pub fn weight(&self) -> usize {
        self.weight
    }

    pub fn push(&mut self, item: T) -> Push<T> {
        let w = item.weight();
        let fits_weight = self.weight + w <= self.max_weight;
        if fits_weight && self.items.len() < self.max_items {
            self.weight += w;
            self.items.push_back(item);
            return Push::Queued;
        }
        match self.overflow {
            Overflow::Backpressure => Push::Full(item),
            // Joining saves an item slot, never weight: it is allowed only when
            // the weight bound still holds.
            Overflow::Coalesce => match self.items.back_mut() {
                Some(last) if fits_weight => match last.merge(item) {
                    Ok(()) => {
                        self.weight += w;
                        Push::Merged
                    }
                    Err(item) => Push::Full(item),
                },
                _ => Push::Full(item),
            },
            Overflow::DropOldest => {
                // An item larger than the whole queue could never fit.
                if w > self.max_weight || self.max_items == 0 {
                    return Push::Full(item);
                }
                let mut dropped = 0;
                while self.weight + w > self.max_weight || self.items.len() >= self.max_items {
                    let Some(old) = self.items.pop_front() else {
                        break;
                    };
                    let ow = old.weight();
                    self.weight -= ow;
                    let gap = self.gap.get_or_insert((0, 0));
                    gap.0 += 1;
                    gap.1 += ow as u64;
                    dropped += 1;
                }
                self.weight += w;
                self.items.push_back(item);
                Push::QueuedAfterDrop { dropped }
            }
        }
    }

    pub fn pop(&mut self) -> Option<Popped<T>> {
        if let Some((items, weight)) = self.gap.take() {
            return Some(Popped::Gap { items, weight });
        }
        let item = self.items.pop_front()?;
        self.weight -= item.weight();
        Some(Popped::Item(item))
    }
}

// ---- the four sources --------------------------------------------------

/// A model text delta. Deltas of one run join into one.
#[derive(Debug, PartialEq, Eq)]
pub struct ModelDelta {
    pub run_id: String,
    pub text: String,
}

impl Item for ModelDelta {
    fn weight(&self) -> usize {
        self.text.len()
    }

    fn merge(&mut self, next: Self) -> Result<(), Self> {
        if self.run_id != next.run_id {
            return Err(next);
        }
        self.text.push_str(&next.text);
        Ok(())
    }
}

/// A PTY output frame at an absolute byte offset of one binding epoch.
#[derive(Debug, PartialEq, Eq)]
pub struct PtyFrame {
    pub epoch: u64,
    pub offset: u64,
    pub bytes: Vec<u8>,
}

impl Item for PtyFrame {
    fn weight(&self) -> usize {
        self.bytes.len()
    }
}

/// A document event: one `document.changed` and the like. Order matters, so
/// none is merged or dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct DocumentEvent {
    pub revision: u64,
}

impl Item for DocumentEvent {
    fn weight(&self) -> usize {
        1
    }
}

/// Typed text from the editor or composer. Adjacent insertions join.
#[derive(Debug, PartialEq, Eq)]
pub enum EditorInput {
    Text(String),
    /// Anything else (a chord, a pointer press) keeps its place.
    Other(String),
}

impl Item for EditorInput {
    fn weight(&self) -> usize {
        match self {
            Self::Text(text) | Self::Other(text) => text.len().max(1),
        }
    }

    fn merge(&mut self, next: Self) -> Result<(), Self> {
        match (&mut *self, next) {
            (Self::Text(a), Self::Text(b)) => {
                a.push_str(&b);
                Ok(())
            }
            (_, next) => Err(next),
        }
    }
}

/// Sizes of the four queues. The defaults are starting points to tune against
/// a recorded workload (R41), not measured limits.
#[derive(Clone, Copy, Debug)]
pub struct QueueLimits {
    pub model_items: usize,
    pub model_bytes: usize,
    pub pty_items: usize,
    pub pty_bytes: usize,
    pub document_events: usize,
    pub editor_items: usize,
    pub editor_bytes: usize,
}

impl Default for QueueLimits {
    fn default() -> Self {
        Self {
            model_items: 64,
            model_bytes: 256 * 1024,
            pty_items: 4096,
            pty_bytes: 1024 * 1024,
            document_events: 1024,
            editor_items: 256,
            editor_bytes: 64 * 1024,
        }
    }
}

/// The four separate queues. One busy source cannot fill another's.
#[derive(Debug)]
pub struct SourceQueues {
    /// Coalesces deltas of one run; refuses when a different run's delta will
    /// not join.
    pub model: BoundedQueue<ModelDelta>,
    /// Drops the oldest frames with a visible gap. Offsets are absolute, so
    /// the consumer resnapshots from the gap instead of guessing.
    pub pty: BoundedQueue<PtyFrame>,
    /// Back-pressure: an edit is never merged or dropped. A refusal sends the
    /// consumer to catch up from history.
    pub documents: BoundedQueue<DocumentEvent>,
    /// Coalesces adjacent typing; back-pressure for everything else, so a key
    /// is refused visibly, never swallowed.
    pub input: BoundedQueue<EditorInput>,
}

impl SourceQueues {
    pub fn new(limits: QueueLimits) -> Self {
        Self {
            model: BoundedQueue::new(limits.model_items, limits.model_bytes, Overflow::Coalesce),
            pty: BoundedQueue::new(limits.pty_items, limits.pty_bytes, Overflow::DropOldest),
            documents: BoundedQueue::new(
                limits.document_events,
                usize::MAX,
                Overflow::Backpressure,
            ),
            input: BoundedQueue::new(limits.editor_items, limits.editor_bytes, Overflow::Coalesce),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delta(run: &str, text: &str) -> ModelDelta {
        ModelDelta {
            run_id: run.into(),
            text: text.into(),
        }
    }

    fn frame(offset: u64, len: usize) -> PtyFrame {
        PtyFrame {
            epoch: 1,
            offset,
            bytes: vec![0; len],
        }
    }

    #[test]
    fn coalesce_joins_the_last_item_when_the_item_bound_is_full() {
        let mut q = BoundedQueue::new(1, 100, Overflow::Coalesce);
        assert_eq!(q.push(delta("r", "abcdefgh")), Push::Queued);
        assert_eq!(q.push(delta("r", "ij")), Push::Merged);
        assert_eq!(q.pop(), Some(Popped::Item(delta("r", "abcdefghij"))));
        assert_eq!(q.pop(), None);
    }

    #[test]
    fn coalesce_cannot_grow_past_the_weight_bound() {
        let mut q = BoundedQueue::new(1, 8, Overflow::Coalesce);
        q.push(delta("r", "abcdefgh"));
        assert_eq!(q.push(delta("r", "i")), Push::Full(delta("r", "i")));
        assert_eq!(q.weight(), 8);
    }

    #[test]
    fn coalesce_hands_back_what_will_not_join() {
        let mut q = BoundedQueue::new(1, 100, Overflow::Coalesce);
        q.push(delta("a", "abcd"));
        assert_eq!(q.push(delta("b", "x")), Push::Full(delta("b", "x")));
        // Nothing was lost or altered.
        assert_eq!(q.pop(), Some(Popped::Item(delta("a", "abcd"))));
    }

    #[test]
    fn drop_oldest_leaves_a_visible_gap_before_the_next_item() {
        let mut q = BoundedQueue::new(100, 10, Overflow::DropOldest);
        q.push(frame(0, 4));
        q.push(frame(4, 4));
        assert_eq!(q.push(frame(8, 8)), Push::QueuedAfterDrop { dropped: 2 });
        assert_eq!(
            q.pop(),
            Some(Popped::Gap {
                items: 2,
                weight: 8
            })
        );
        assert_eq!(q.pop(), Some(Popped::Item(frame(8, 8))));
        assert_eq!(q.pop(), None);
        assert_eq!(q.weight(), 0);
    }

    #[test]
    fn drop_oldest_also_answers_the_item_bound() {
        let mut q = BoundedQueue::new(2, 100, Overflow::DropOldest);
        q.push(frame(0, 1));
        q.push(frame(1, 1));
        assert_eq!(q.push(frame(2, 1)), Push::QueuedAfterDrop { dropped: 1 });
        assert_eq!(q.len(), 2);
    }

    #[test]
    fn drop_oldest_refuses_an_item_bigger_than_the_queue() {
        let mut q = BoundedQueue::new(100, 4, Overflow::DropOldest);
        q.push(frame(0, 2));
        assert_eq!(q.push(frame(2, 9)), Push::Full(frame(2, 9)));
        // The queued frame survives: a hopeless item does not evict anyone.
        assert_eq!(q.pop(), Some(Popped::Item(frame(0, 2))));
    }

    #[test]
    fn gaps_accumulate_until_popped() {
        let mut q = BoundedQueue::new(100, 4, Overflow::DropOldest);
        q.push(frame(0, 4));
        q.push(frame(4, 4));
        q.push(frame(8, 4));
        assert_eq!(
            q.pop(),
            Some(Popped::Gap {
                items: 2,
                weight: 8
            })
        );
    }

    #[test]
    fn backpressure_returns_the_item_and_keeps_order() {
        let mut q = BoundedQueue::new(2, usize::MAX, Overflow::Backpressure);
        assert_eq!(q.push(DocumentEvent { revision: 1 }), Push::Queued);
        assert_eq!(q.push(DocumentEvent { revision: 2 }), Push::Queued);
        assert_eq!(
            q.push(DocumentEvent { revision: 3 }),
            Push::Full(DocumentEvent { revision: 3 })
        );
        assert_eq!(q.pop(), Some(Popped::Item(DocumentEvent { revision: 1 })));
        // Room again: the producer may retry.
        assert_eq!(q.push(DocumentEvent { revision: 3 }), Push::Queued);
    }

    #[test]
    fn typing_coalesces_but_other_input_is_refused_not_swallowed() {
        let mut q = BoundedQueue::new(1, 100, Overflow::Coalesce);
        q.push(EditorInput::Text("abcd".into()));
        assert_eq!(q.push(EditorInput::Text("e".into())), Push::Merged);
        assert_eq!(
            q.push(EditorInput::Other("Enter".into())),
            Push::Full(EditorInput::Other("Enter".into()))
        );
    }

    #[test]
    fn one_busy_source_does_not_fill_another() {
        let mut queues = SourceQueues::new(QueueLimits {
            model_items: 2,
            model_bytes: 8,
            pty_items: 2,
            pty_bytes: 8,
            document_events: 2,
            editor_items: 2,
            editor_bytes: 8,
        });
        for i in 0..100 {
            queues.pty.push(frame(i * 4, 4));
        }
        assert_eq!(
            queues.input.push(EditorInput::Text("k".into())),
            Push::Queued
        );
        assert_eq!(
            queues.documents.push(DocumentEvent { revision: 1 }),
            Push::Queued
        );
        assert!(queues.pty.weight() <= 8);
    }
}
