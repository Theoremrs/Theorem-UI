//! The directory model behind the Files panel: what is loaded, what is
//! expanded, and what is happening to each row. No I/O and no drawing.
//!
//! Paths are workspace-relative and `/`-separated; the root is `""`.

use std::collections::BTreeMap;

use theorem_workbench_core::completion::{FileKind, FileListing, Outcome};
use theorem_workbench_core::ids::EffectId;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub name: String,
    pub kind: FileKind,
}

pub fn join(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_owned()
    } else {
        format!("{dir}/{name}")
    }
}

/// The directory a path sits in; `""` for a top-level path.
pub fn parent(path: &str) -> &str {
    path.rfind('/').map_or("", |i| &path[..i])
}

pub fn name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |i| &path[i + 1..])
}

fn within(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Why a read or a write did not give what was asked, in the owner's words.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Problem {
    Refused {
        code: String,
        reason: String,
    },
    /// The environment or the capability is not there at all.
    Unavailable {
        reason: String,
    },
    /// The result is not known. Shown as unknown, never as done.
    Unknown {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

impl Problem {
    pub fn of(outcome: &Outcome) -> Option<Self> {
        match outcome {
            Outcome::Accepted => None,
            Outcome::Refused { code, reason }
                if matches!(
                    code.as_str(),
                    "environment_unavailable" | "missing_capability"
                ) =>
            {
                Some(Self::Unavailable {
                    reason: reason.clone(),
                })
            }
            Outcome::Refused { code, reason } => Some(Self::Refused {
                code: code.clone(),
                reason: reason.clone(),
            }),
            Outcome::Uncertain { reason } => Some(Self::Unknown {
                reason: reason.clone(),
            }),
            Outcome::Failed { reason } => Some(Self::Failed {
                reason: reason.clone(),
            }),
        }
    }

    pub fn label(&self) -> String {
        match self {
            Self::Refused { code, reason } => format!("refused ({code}): {reason}"),
            Self::Unavailable { reason } => format!("unavailable: {reason}"),
            Self::Unknown { reason } => format!("unknown result: {reason}; F5 to refresh"),
            Self::Failed { reason } => format!("failed: {reason}"),
        }
    }
}

/// What is happening to one row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NoteState {
    Pending(String),
    Problem(Problem),
}

impl NoteState {
    pub fn label(&self) -> String {
        match self {
            Self::Pending(what) => what.clone(),
            Self::Problem(p) => p.label(),
        }
    }
}

/// A row's note. `ghost` is set for a row the listing does not (yet) have: a
/// file being created, so a refused or unknown create stays visible.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Note {
    pub state: NoteState,
    pub ghost: Option<Entry>,
}

#[derive(Debug, Default)]
pub struct Dir {
    entries: Vec<Entry>,
    pub loaded: bool,
    /// The host said the listing may be a subset.
    pub partial: bool,
    pub problem: Option<Problem>,
    /// The `filesList` effect in flight for this directory.
    pub listing: Option<EffectId>,
    /// A listing is owed: first expansion, a change, a resync or a refresh.
    pub wanted: bool,
    /// Set by a person's refresh: the next listing clears unknown results.
    pub manual: bool,
    pub expanded: bool,
}

fn sort_key(e: &Entry) -> (bool, String, String) {
    (
        e.kind != FileKind::Directory,
        e.name.to_lowercase(),
        e.name.clone(),
    )
}

/// Transient drawing state the rows depend on.
#[derive(Default)]
pub struct Overlay<'a> {
    /// The path being renamed.
    pub rename: Option<&'a str>,
    /// A new entry is being named in this directory; `true` for a folder.
    pub new_in: Option<(&'a str, bool)>,
    /// The path a delete is waiting on.
    pub confirm: Option<&'a str>,
    /// The marked path and whether it is cut (`true`) or copied.
    pub clip: Option<(&'a str, bool)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Row {
    Entry {
        path: String,
        name: String,
        kind: FileKind,
        depth: usize,
        expanded: Option<bool>,
        note: Option<NoteState>,
        mark: Option<&'static str>,
        /// 1-based place among its siblings, and how many there are.
        pos: usize,
        set: usize,
    },
    /// A line about the directory above it: loading, empty, refused, partial.
    Status {
        depth: usize,
        text: String,
    },
    /// The inline name field. `path` is the row it replaces, or a placeholder
    /// for a new entry.
    Edit {
        depth: usize,
        path: String,
        rename: bool,
        directory: bool,
    },
    Confirm {
        depth: usize,
        text: String,
    },
}

impl Row {
    /// The path the cursor rests on, for rows the cursor can rest on.
    pub fn path(&self) -> Option<&str> {
        match self {
            Self::Entry { path, .. } | Self::Edit { path, .. } => Some(path),
            Self::Status { .. } | Self::Confirm { .. } => None,
        }
    }

    pub fn depth(&self) -> usize {
        match self {
            Self::Entry { depth, .. }
            | Self::Status { depth, .. }
            | Self::Edit { depth, .. }
            | Self::Confirm { depth, .. } => *depth,
        }
    }
}

#[derive(Debug)]
pub struct Tree {
    dirs: BTreeMap<String, Dir>,
    pub notes: BTreeMap<String, Note>,
}

impl Tree {
    pub fn new() -> Self {
        let mut tree = Self {
            dirs: BTreeMap::new(),
            notes: BTreeMap::new(),
        };
        tree.dirs.insert(
            String::new(),
            Dir {
                expanded: true,
                wanted: true,
                ..Dir::default()
            },
        );
        tree
    }

    pub fn dir(&self, path: &str) -> Option<&Dir> {
        self.dirs.get(path)
    }

    pub fn dir_mut(&mut self, path: &str) -> Option<&mut Dir> {
        self.dirs.get_mut(path)
    }

    pub fn dirs(&self) -> impl Iterator<Item = (&String, &Dir)> {
        self.dirs.iter()
    }

    pub fn is_expanded(&self, path: &str) -> bool {
        path.is_empty() || self.dirs.get(path).is_some_and(|d| d.expanded)
    }

    /// Every ancestor of `dir` is expanded, so its rows can be on screen.
    pub fn visible(&self, dir: &str) -> bool {
        if dir.is_empty() {
            return true;
        }
        let mut p = parent(dir);
        loop {
            if !self.is_expanded(p) {
                return false;
            }
            if p.is_empty() {
                return true;
            }
            p = parent(p);
        }
    }

    /// Expanding lists a directory the first time only; a loaded one is not
    /// listed again until something says it changed.
    pub fn set_expanded(&mut self, path: &str, on: bool) {
        if path.is_empty() {
            return;
        }
        let dir = self.dirs.entry(path.to_owned()).or_default();
        dir.expanded = on;
        if on && dir.listing.is_none() && (!dir.loaded || dir.problem.is_some()) {
            dir.wanted = true;
        }
    }

    pub fn want(&mut self, path: &str) {
        if let Some(dir) = self.dirs.get_mut(path) {
            dir.wanted = true;
        }
    }

    pub fn expanded_paths(&self) -> Vec<String> {
        self.dirs
            .iter()
            .filter(|(p, d)| !p.is_empty() && d.expanded)
            .map(|(p, _)| p.clone())
            .collect()
    }

    /// The entries of `dir`, with rows the listing does not have yet.
    pub fn children(&self, dir: &str) -> Vec<Entry> {
        let mut out = self
            .dirs
            .get(dir)
            .map(|d| d.entries.clone())
            .unwrap_or_default();
        for (path, note) in &self.notes {
            if let Some(ghost) = &note.ghost
                && parent(path) == dir
                && !out.iter().any(|e| e.name == ghost.name)
            {
                out.push(ghost.clone());
            }
        }
        out.sort_by_key(sort_key);
        out
    }

    pub fn kind_of(&self, path: &str) -> Option<FileKind> {
        self.children(parent(path))
            .into_iter()
            .find(|e| e.name == name_of(path))
            .map(|e| e.kind)
    }

    /// Replace one directory's entries with what the host listed. Other
    /// directories are left alone.
    pub fn ingest(&mut self, dir: &str, listing: FileListing) {
        let mut entries: Vec<Entry> = listing
            .entries
            .into_iter()
            .map(|e| Entry {
                name: e.name,
                kind: e.kind,
            })
            .collect();
        entries.sort_by_key(sort_key);
        let Some(d) = self.dirs.get_mut(dir) else {
            return;
        };
        let manual = std::mem::take(&mut d.manual);
        d.entries = entries.clone();
        d.loaded = true;
        d.partial = listing.partial;
        d.problem = None;
        // What is no longer there, or is no longer a directory, takes its
        // loaded subtree with it.
        let gone: Vec<String> = self
            .dirs
            .keys()
            .filter(|p| !p.is_empty() && parent(p) == dir)
            .filter(|p| {
                !entries
                    .iter()
                    .any(|e| e.name == name_of(p) && e.kind == FileKind::Directory)
            })
            .cloned()
            .collect();
        for path in gone {
            self.remove_subtree(&path);
        }
        self.notes.retain(|path, note| {
            if parent(path) != dir {
                return true;
            }
            let listed = entries.iter().any(|e| e.name == name_of(path));
            match &note.state {
                NoteState::Pending(_) => true,
                NoteState::Problem(Problem::Unknown { .. }) if manual => false,
                _ => listed || note.ghost.is_some(),
            }
        });
    }

    pub fn remove_subtree(&mut self, path: &str) {
        self.dirs.retain(|p, _| !within(p, path));
        self.notes.retain(|p, _| !within(p, path));
    }

    /// Carry loaded and expanded state from `from` to `to` after a move.
    pub fn move_subtree(&mut self, from: &str, to: &str) {
        let keys: Vec<String> = self
            .dirs
            .keys()
            .filter(|p| within(p, from))
            .cloned()
            .collect();
        for key in keys {
            if let Some(mut dir) = self.dirs.remove(&key) {
                dir.listing = None;
                self.dirs.insert(format!("{to}{}", &key[from.len()..]), dir);
            }
        }
        self.notes.retain(|p, _| !within(p, from));
    }

    pub fn insert_entry(&mut self, dir: &str, entry: Entry) {
        let Some(d) = self.dirs.get_mut(dir) else {
            return;
        };
        if !d.loaded {
            return;
        }
        d.entries.retain(|e| e.name != entry.name);
        d.entries.push(entry);
        d.entries.sort_by_key(sort_key);
    }

    /// Take `path` out of its directory's entries. Its loaded subtree stays,
    /// for a move to carry.
    pub fn remove_entry(&mut self, path: &str) {
        if let Some(d) = self.dirs.get_mut(parent(path)) {
            d.entries.retain(|e| e.name != name_of(path));
        }
    }

    /// `path` is gone: its entry, its subtree and its notes.
    pub fn forget(&mut self, path: &str) {
        self.remove_entry(path);
        self.remove_subtree(path);
    }

    pub fn rows(&self, overlay: &Overlay) -> Vec<Row> {
        let mut out = vec![];
        self.push_dir("", 0, overlay, &mut out);
        out
    }

    fn push_dir(&self, dir: &str, depth: usize, overlay: &Overlay, out: &mut Vec<Row>) {
        if let Some((target, directory)) = overlay.new_in
            && target == dir
        {
            out.push(Row::Edit {
                depth,
                path: join(dir, "\0new"),
                rename: false,
                directory,
            });
        }
        let kids = self.children(dir);
        let set = kids.len();
        for (i, entry) in kids.iter().enumerate() {
            let path = join(dir, &entry.name);
            let is_dir = entry.kind == FileKind::Directory;
            if overlay.rename == Some(path.as_str()) {
                out.push(Row::Edit {
                    depth,
                    path: path.clone(),
                    rename: true,
                    directory: is_dir,
                });
            } else {
                out.push(Row::Entry {
                    path: path.clone(),
                    name: entry.name.clone(),
                    kind: entry.kind,
                    depth,
                    expanded: is_dir.then(|| self.is_expanded(&path)),
                    note: self.notes.get(&path).map(|n| n.state.clone()),
                    mark: match overlay.clip {
                        Some((p, true)) if p == path => Some("cut"),
                        Some((p, false)) if p == path => Some("copy"),
                        _ => None,
                    },
                    pos: i + 1,
                    set,
                });
            }
            if overlay.confirm == Some(path.as_str()) {
                let and = if is_dir { " and everything in it" } else { "" };
                out.push(Row::Confirm {
                    depth,
                    text: format!("Delete {}{and}? Enter deletes, Escape cancels", entry.name),
                });
            }
            if is_dir && self.is_expanded(&path) {
                self.push_dir(&path, depth + 1, overlay, out);
            }
        }
        let text = match self.dirs.get(dir) {
            None => Some("loading".to_owned()),
            Some(d) => match &d.problem {
                Some(p) => Some(p.label()),
                None if !d.loaded => Some("loading".to_owned()),
                None if set == 0 && overlay.new_in.is_none_or(|(t, _)| t != dir) => {
                    Some("empty".to_owned())
                }
                None => None,
            },
        };
        if let Some(text) = text {
            out.push(Row::Status { depth, text });
        }
        if self.dirs.get(dir).is_some_and(|d| d.partial) {
            out.push(Row::Status {
                depth,
                text: "partial: this listing may be a subset".to_owned(),
            });
        }
    }
}
