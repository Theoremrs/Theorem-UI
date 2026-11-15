//! The interaction core of the Theo Web terminal workbench: the types an Elm
//! root exchanges with its host, and the rules that keep a late answer from
//! overwriting newer work. Pure Rust: no browser, no `ratzilla`.
//!
//! `update` returns [`Effect`]s; the host performs them through their owners
//! and answers with a [`Completion`]; a pane asks [`stale::judge`] what to do
//! with it. Everything that crosses the wasm boundary is serde JSON, and with
//! the `ts` feature each type also derives its TypeScript declaration.

pub mod arrangement;
pub mod builtin;
pub mod completion;
pub mod draft;
pub mod effect;
pub mod factory;
pub mod host;
pub mod ids;
pub mod keys;
pub mod model;
pub mod msg;
pub mod panel;
pub mod panels;
pub mod picker;
pub mod picker_layout;
pub mod queue;
pub mod registry;
pub mod results;
pub mod semantics;
pub mod stale;
pub mod theme;
pub mod tree;
pub mod update;
pub mod view;

pub use arrangement::{ArrangementInfo, ArrangementMsg, ArrangementNotice};
pub use completion::{Completion, CompletionPayload, Outcome};
pub use draft::{DraftAttachment, DraftAttachmentState, ModelChoice, SourceReference};
pub use effect::{Effect, EffectBody, EffectKind, Owner};
pub use factory::{OPENER_DEFAULT, OPENER_SPECIFIC, Opener, PanelFactories};
pub use host::{HostMessage, LocalProblem, LocalState, LocalStatus};
pub(crate) use ids::string_id;
pub use ids::{
    ActionId, Actor, Capability, EffectId, EffectIds, Generation, PanelInstanceId, PanelKind,
    ResourceKind, ResourceRef, Revision, WorkspaceIdentity,
};
pub use model::{Counters, Focus, Model, Notice, RestoreError, Viewport};
pub use msg::{DockMsg, Inbound, Msg, Pointer};
pub use panel::{
    Button, Caret, CaretPhase, CaretShape, Composition, Ctx, EmitError, OpenTarget, Panel,
    PanelMsg, PanelPointer, PickerView, PointerKind, TabLabel, ViewCtx,
};
pub use theme::Theme;
pub use tree::semantics;
pub use update::update;
pub use view::view;
