//! What the chooser offers. The core has no message that lists terminal
//! sessions or profiles (capabilities are a set of names), so the mount hands
//! the pane a shared [`ProcessCatalog`] and updates it from the terminal
//! owner's own data: the profile table and the adopted sessions of the
//! workspace. The pane only reads it; it never reaches the host itself.

use std::cell::RefCell;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use theorem_workbench_core::effect::TerminalBackend;

fn yes() -> bool {
    true
}

/// A profile a new process may be started from. `backend` is named by the
/// profile and never changed by the pane: a Herdr profile that is unavailable
/// stays unavailable (R25), it is not offered as a native shell instead.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessProfile {
    pub id: String,
    pub label: String,
    pub backend: TerminalBackend,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    /// False when the host reports the backend not ready.
    #[serde(default = "yes")]
    pub available: bool,
    /// The host's words for why it is not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

/// What the host says about a session's program. Never read from output.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    #[default]
    Running,
    Exited,
    Lost,
}

/// A terminal session of the workspace this pane may attach to.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessSession {
    pub session: String,
    /// The profile it was started from, as people name it.
    pub profile: String,
    pub backend: TerminalBackend,
    pub workspace: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<u64>,
    #[serde(default)]
    pub state: SessionState,
    /// Another viewer holds the control lease.
    #[serde(default)]
    pub controlled_elsewhere: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogData {
    #[serde(default)]
    pub profiles: Vec<ProcessProfile>,
    #[serde(default)]
    pub sessions: Vec<ProcessSession>,
}

struct Inner {
    data: CatalogData,
    version: u64,
}

/// The shared handle. Clone it into the mount and into `register`; wasm32 here
/// is single-threaded, so `Rc<RefCell>` is the whole story.
#[derive(Clone)]
pub struct ProcessCatalog {
    inner: Rc<RefCell<Inner>>,
    nonce: Rc<str>,
}

impl ProcessCatalog {
    /// `load_nonce` must differ between page loads (a random string): it keeps
    /// minted input ids and attachment names unique across reloads, which the
    /// host's input ledger relies on.
    pub fn new(load_nonce: impl Into<String>) -> Self {
        Self {
            inner: Rc::new(RefCell::new(Inner {
                data: CatalogData::default(),
                version: 0,
            })),
            nonce: Rc::from(load_nonce.into()),
        }
    }

    /// Replace what the chooser offers. A pane redraws on its next tick.
    pub fn set(&self, data: CatalogData) {
        let mut inner = self.inner.borrow_mut();
        if inner.data != data {
            inner.data = data;
            inner.version += 1;
        }
    }

    /// The same from the JSON the TypeScript owner produces.
    pub fn set_json(&self, value: serde_json::Value) -> Result<(), serde_json::Error> {
        self.set(serde_json::from_value(value)?);
        Ok(())
    }

    pub fn snapshot(&self) -> CatalogData {
        self.inner.borrow().data.clone()
    }

    pub(crate) fn version(&self) -> u64 {
        self.inner.borrow().version
    }

    pub(crate) fn nonce(&self) -> &str {
        &self.nonce
    }
}

/// What persistence means for a backend, in the words the chooser shows.
pub(crate) fn persistence(backend: TerminalBackend) -> &'static str {
    match backend {
        TerminalBackend::Herdr => "survives pane close and refresh",
        TerminalBackend::Native => "not kept by Herdr, ends with the host",
    }
}

pub(crate) fn backend_word(backend: TerminalBackend) -> &'static str {
    match backend {
        TerminalBackend::Herdr => "Herdr",
        TerminalBackend::Native => "native",
    }
}
