//! The interaction core of the Theo Web terminal workbench: the types an Elm
//! root exchanges with its host, and the rules that keep a late answer from
//! overwriting newer work. Pure Rust: no browser, no `ratzilla`.
//!
//! `update` returns [`Effect`]s; the host performs them through their owners
//! and answers with a [`Completion`]; a pane asks [`stale::judge`] what to do
//! with it. Everything that crosses the wasm boundary is serde JSON, and with
//! the `ts` feature each type also derives its TypeScript declaration.

pub mod builtin;
pub mod completion;
pub mod effect;
pub mod host;
pub mod ids;
pub mod keys;
pub mod picker;
pub mod queue;
pub mod registry;
pub mod semantics;
pub mod stale;

pub use completion::{Completion, CompletionPayload, Outcome};
pub use effect::{Effect, EffectBody, EffectKind, Owner};
pub use host::HostMessage;
pub(crate) use ids::string_id;
pub use ids::{
    ActionId, Actor, Capability, EffectId, EffectIds, Generation, PanelInstanceId, PanelKind,
    ResourceKind, ResourceRef, Revision,
};
