//! What the chooser offers, as the host last said it in
//! `HostMessage::TerminalSessions`. Each message replaces both lists. The root
//! sends a host message only to panes that are open, so the latest message is
//! also kept here, shared by the panes one `register` call builds: a pane
//! opened afterwards shows it at once instead of waiting for the next message.

use std::cell::RefCell;
use std::rc::Rc;

use theorem_workbench_core::effect::TerminalBackend;

pub(crate) use theorem_workbench_core::host::{
    TerminalProfileInfo as ProcessProfile, TerminalSessionInfo as ProcessSession,
    TerminalSessionState as SessionState,
};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct CatalogData {
    /// The workspace the host said these for.
    pub workspace: String,
    pub profiles: Vec<ProcessProfile>,
    pub sessions: Vec<ProcessSession>,
    /// Whether the host has finished finding surviving terminals. `None` is a
    /// host that does not say, which is not the same as settled.
    pub adoption: Option<theorem_workbench_core::host::TerminalAdoption>,
}

struct Inner {
    data: CatalogData,
    version: u64,
}

/// The pane's view of the host's latest listing.
#[derive(Clone)]
pub(crate) struct Catalog {
    inner: Rc<RefCell<Inner>>,
    nonce: Rc<str>,
    /// Agent input claims, shared by the same panes as the listing, so every
    /// view of a terminal sees one answer.
    control: Rc<RefCell<crate::control::Control>>,
}

impl Catalog {
    /// `load_nonce` must differ between page loads: it keeps minted input ids
    /// and attachment names unique across reloads, which the host's input
    /// ledger relies on.
    pub(crate) fn new(load_nonce: impl Into<String>) -> Self {
        Self {
            inner: Rc::new(RefCell::new(Inner {
                data: CatalogData::default(),
                version: 0,
            })),
            nonce: Rc::from(load_nonce.into()),
            control: Rc::default(),
        }
    }

    pub(crate) fn replace(&self, data: CatalogData) {
        let mut inner = self.inner.borrow_mut();
        if inner.data != data {
            inner.data = data;
            inner.version += 1;
        }
    }

    /// The listing, or an empty one when it was said for another workspace.
    pub(crate) fn snapshot(&self, workspace: &str) -> CatalogData {
        let inner = self.inner.borrow();
        if inner.data.workspace == workspace {
            inner.data.clone()
        } else {
            CatalogData::default()
        }
    }

    pub(crate) fn version(&self) -> u64 {
        self.inner.borrow().version
    }

    pub(crate) fn control(&self) -> std::cell::RefMut<'_, crate::control::Control> {
        self.control.borrow_mut()
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
