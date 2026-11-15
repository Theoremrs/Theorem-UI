//! Shared setup for the panel tests: wire payloads and a buffer to read back.
#![allow(dead_code)]

use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use theorem_workbench_changes::{Changes, ChangesStyles, Intent, IntentKind};
use theorem_workbench_core::completion::{
    BranchState, CompletionPayload, DiffHunk, LogEntry, Outcome, RepoState, ScmChange,
    ScmDiffResult, ScmLogResult, ScmStatus,
};

pub fn change(path: &str, index: &str, worktree: &str) -> ScmChange {
    ScmChange {
        path: path.into(),
        index: index.into(),
        worktree: worktree.into(),
        original_path: None,
        conflict: false,
    }
}

pub fn conflict(path: &str) -> ScmChange {
    ScmChange {
        conflict: true,
        ..change(path, "U", "U")
    }
}

pub fn repo(generation: u32) -> RepoState {
    RepoState {
        head: Some("abc1234def".into()),
        branch: BranchState::Named("main".into()),
        index_generation: Some(generation.to_string()),
        worktree_generation: Some(generation.to_string()),
    }
}

pub fn status(generation: u32, changes: Vec<ScmChange>) -> CompletionPayload {
    CompletionPayload::Scm(ScmStatus {
        branch: Some("main".into()),
        head: Some("abc1234def".into()),
        changes,
        state: Some(repo(generation)),
    })
}

pub fn diff_answer(path: &str, staged: bool, text: &str, generation: u32) -> CompletionPayload {
    CompletionPayload::ScmDiff(ScmDiffResult {
        path: Some(path.into()),
        staged,
        commit: None,
        text: text.into(),
        hunks: Vec::<DiffHunk>::new(),
        state: Some(repo(generation)),
    })
}

pub fn log_answer(subjects: &[&str]) -> CompletionPayload {
    CompletionPayload::ScmLog(ScmLogResult {
        commits: subjects
            .iter()
            .enumerate()
            .map(|(at, subject)| LogEntry {
                commit: format!("a1b2c3{at}{}", "0".repeat(33)),
                author: "Ada".into(),
                email: None,
                timestamp: "0".into(),
                subject: (*subject).into(),
                body: None,
            })
            .collect(),
        state: None,
    })
}

pub const SMALL_DIFF: &str = "\
diff --git a/src/main.rs b/src/main.rs
index 1111111..2222222 100644
--- a/src/main.rs
+++ b/src/main.rs
@@ -1,4 +1,4 @@
 fn main() {
-    println!(\"hello\");
+    println!(\"hello, world\");
     run();
 }
";

/// Applies an accepted answer and returns what follows.
pub fn accept(model: &mut Changes, intent: &Intent, payload: CompletionPayload) -> Vec<Intent> {
    model.complete(intent.id, &Outcome::Accepted, Some(&payload))
}

pub fn accept_bare(model: &mut Changes, intent: &Intent) -> Vec<Intent> {
    model.complete(intent.id, &Outcome::Accepted, None)
}

pub fn fail(model: &mut Changes, intent: &Intent, outcome: Outcome) -> Vec<Intent> {
    model.complete(intent.id, &outcome, None)
}

/// A model that has read a status. Returns what the first read asked for next (the log
/// only, when there is a commit).
pub fn loaded(changes: Vec<ScmChange>) -> Changes {
    let mut model = Changes::new();
    let read = model.refresh();
    assert_eq!(read.kind, IntentKind::Status);
    let next = accept(&mut model, &read, status(1, changes));
    for intent in next {
        match intent.kind {
            IntentKind::Log { .. } => {
                accept(&mut model, &intent, log_answer(&["first", "second"]));
            }
            other => panic!("unexpected follow-up {other:?}"),
        }
    }
    model
}

pub fn lines(buf: &Buffer) -> Vec<String> {
    (buf.area.y..buf.area.y + buf.area.height)
        .map(|y| {
            let mut line = String::new();
            let mut skip = 0usize;
            for x in buf.area.x..buf.area.x + buf.area.width {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                let symbol = buf[(x, y)].symbol();
                skip = unicode_width::UnicodeWidthStr::width(symbol).saturating_sub(1);
                line.push_str(symbol);
            }
            line.trim_end().to_owned()
        })
        .collect()
}

pub fn render(model: &Changes, width: u16, height: u16) -> Vec<String> {
    let area = Rect::new(0, 0, width, height);
    let mut buf = Buffer::empty(area);
    model.draw(area, &mut buf, &ChangesStyles::plain());
    lines(&buf)
}

/// The next intent of a kind, from a list.
pub fn kinds(intents: &[Intent]) -> Vec<&IntentKind> {
    intents.iter().map(|i| &i.kind).collect()
}
