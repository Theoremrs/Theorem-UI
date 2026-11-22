# Closing the gap: freely authored interactive artifacts in Theorem answers

**Corrected execution plan · November 17, 2026**

This revision records the user's latest direction and supersedes the previous SceneOS-first execution plan. Implementation is underway separately. This document does not certify that the corrections are merged, deployed, or verified in the running product.

## 1. Decision

Make ordinary TypeScript/TSX source the authoring authority for interactive answer artifacts. Use the existing durable App compiler, checking, runtime, state, revision, source-editing, and conversation-reference path. The agent can import a useful library, compose existing components, or write new components and behavior immediately.

Remove required routing through the specialized `show_scene` explanation path and the fixed dependency ceiling in the App path. Preserve access to historical scene messages and useful rendering code where appropriate. Neither a scene grammar, a part schema, nor a component catalog should be required to express a new artifact.

The previous plan treated the remaining work mainly as connecting SceneOS to a common lifecycle. That underestimated the authoring and interaction restrictions. The subsequent proposal for a generalized part contract also imposed a boundary the user rejected. Both are superseded by this source-based direction.

## 2. Product outcome

An ordinary answer can contain a live app that the person can operate, discuss, and revise. The representation follows the subject: conventional UI, chart, diagram, notebook, or spatial simulation. Particles and three dimensions are useful choices for some artifacts, not requirements for every answer.

The original Luma ambition remains meaningful: a suitable spatial example should have depth, directly manipulable parts, and newly authored behavior on request. A CPU or small adder can demonstrate this. It is an exemplar, not a fixed preset or a mandatory acceptance subject.

The completed path should provide:

- Live inline interaction without a preliminary activation gate.
- Expansion of the same running instance, preserving user state and selection.
- Revisions of the same durable App through existing source operations.
- Optional source-linked or semantic selection for precise follow-up questions.
- Saved state through the existing App API, with transient view state handled deliberately by the app.
- Useful diagnostics from source checking, bundling, and observed execution.
- Appropriate behavior for historical revisions and previously saved artifacts.

Prior conversation summaries support web first, native later; minimal inline chrome; particles only where useful; and continuity of meaning and behavior. Those summaries were retrieved without stable original conversation links. The user's explicit November 17 corrections take precedence over earlier assistant architecture proposals.

## 3. Existing implementation to reuse

The following are source observations at the named revisions. They are a baseline for the changes, not claims about deployed behavior.

| Existing owner | Verified baseline | Implementation implication |
| --- | --- | --- |
| Durable App publication and checking | Theorem `a7ea1f19…` has App revision/publication and client-check operations. | Reuse these operations and their receipts. |
| App source pipeline | Theorem-UI `35cf1e40…` uses `esbuild-wasm` for TS/TSX bundling and an existing module worker for type checking. | Extend the existing dependency resolution; do not introduce another compiler/runtime. |
| Type checker | `@tsrs/wasm` is already pinned to `0.23.0-ts7.1.0-beta`. The checking worker uses it. | This work is not a tsrs adoption or version upgrade. Bundling remains the separate esbuild responsibility. |
| Live App rendering | The registry's interactive App representation mounts `DocumentApp`; it already supplies saved state, source editing, and revision behavior. | Route live answer artifacts into that existing path. |
| Passive App presentation | The audited answer card initially selected preview and required Interact; the preview used pinned/isolated behavior. | Correct answer presentation without turning a pinned preview into the mutable live owner. |
| Selection | JSX source instrumentation and the App bridge support source-linked selection; additional entity metadata is optional. | Preserve existing references. Require richer selection only for an app that needs it. |
| Expansion pattern | The existing SceneCard uses native dialog promotion while retaining its iframe. | Apply the same continuity principle to the live App body. |

Relevant source:

- [App turn/publication owner](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/rustyred-thg-server/src/theorem_agent_stream/conversation_app_turn.rs)
- [UI dependency versions](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/package.json)
- [App bundling and JSX instrumentation](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/src/lib/blocks/export.ts)
- [Checking worker owner](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/src/lib/blocks/app-checker.ts)
- [Live DocumentApp](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/src/components/blocks/document-app.tsx)
- [Artifact registry](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/src/components/artifacts/artifact-registry.tsx)
- [App references](https://github.com/Travis-Gilbert/Theorem-UI/blob/35cf1e40ddd347a5ce285efa102d913aef37ed8c/src/lib/theorem/app-references.ts)

## 4. Implementation sequence

### A. Restore source authoring as the ordinary route

Review prompt guidance, tool installation, narrowed agent catalogs, and continuation instructions together. Remove normal-conversation guidance that forces suitable interactive work into `show_scene` or a fixed explanation preset. Direct the agent to the existing App source operations and permit newly authored TSX components and logic.

Keep the useful part of the guidance: choose a representation that helps the answer, make interactions meaningful, and revise the existing artifact when continuing it. A new component should not need host registration.

### B. Remove the fixed import ceiling using the existing compiler

Extend the App dependency resolver and checker together so authored source can use browser-compatible packages beyond the current prebundled set. Preserve a shared React runtime and resolve package subpaths, transitive dependencies, and declarations consistently. Surface actionable errors when a dependency cannot work in the target environment.

Maintain the existing tsrs worker for type checking and esbuild-wasm for bundling. Do not report bundling as type checking or diagnostics as proof of runtime success. A package's own CSS, fonts, assets, and required transforms still need support; package import freedom does not automatically supply every build plugin.

Keep optional libraries optional. Astryx, A2UI, Luma, or reusable Theorem helpers can improve an artifact, but importing one must not become a requirement for every app. In particular, do not copy a UI kit's mandatory-template rules into the global artifact-authoring policy.

### C. Deliver a live answer through the existing App renderer

Select the registry's live representation on arrival. Retain `DocumentApp` as the mutable live owner and the existing revision renderer for historical versions. Keep source editing, state saves, errors, reload, and Ask actions connected to their current owners.

Use one mounted body for inline and expanded display. Dialog promotion must not open a second runtime in a dock, move an iframe through a remounting portal, or rebuild the host merely because the title or answer text changes. Preserve focus in the composer when an artifact arrives; return focus appropriately after an explicit expand/collapse action.

The registry should decide presentation behavior from the selected representation. Verify that changes also preserve other registered artifact kinds and historical revision navigation.

### D. Preserve source, state, and conversational continuity

Reuse App identity and revision checks for updates. Keep the selected source location associated with the source revision actually displayed. A request concerning an old revision should not silently mutate the latest one.

Use the existing App state API for data the artifact promises to save. Treat temporary camera motion, hover, and animation state according to the app's needs. Any migration or deliberate reset after a source change should be explicit in the artifact behavior. These decisions can be ordinary source code; they do not require a universal component-state schema.

Retain the existing client-check/receipt path. Distinguish a saved revision, a successful source check, a successful bundle, and observed browser execution. Missing browser evidence remains unobserved rather than passing.

### E. Prove breadth and the intended experience

Use two small ordinary-chat examples: one conventional UI and one spatial example where direct manipulation helps explain the subject. In each, ask the agent for a new component or behavior that was not supplied as a preset. Then request a revision of the same artifact.

These examples should reveal concrete shortcomings in the source pipeline and interaction lifecycle. Fix those shortcomings in their existing owners. Do not use the examples to establish a required component vocabulary.

## 5. Modularity without a new artifact language

The agent can separate behavior, state, rendering, theme, and reusable source with ordinary modules and React APIs. Small artifacts can stay in one source file; larger ones can use the source structure supported by the App pipeline. Library interfaces are local choices within that source.

A successful reusable component can later become a shared package. Immediate authoring and execution should not depend on that promotion. Optional entity IDs or domain semantics can improve picking and conversation context without being compulsory for every button, chart, or generated object.

The existing App store, runtime, registry, and bridge remain the owners. There is no proposed parallel artifact store, renderer framework, event bus, or required part-definition registry.

## 6. Verification and delivery evidence

Record the exact backend/frontend revisions used. Keep these checks separate:

| Check | What must be demonstrated |
| --- | --- |
| Authoring and routing | An ordinary agent turn produces App TSX, including a newly authored component, through the real source operations. |
| Dependencies | A representative browser package outside the former fixed list resolves in both checking and bundling; unsupported packages produce useful diagnostics. |
| Immediate rendering | The resulting artifact is interactive inside the answer without an activation step. |
| Instance continuity | A changed in-frame value and the same iframe survive expansion, streamed rerender, collapse, and Escape. |
| Revisions and selection | Source editing and Ask target the displayed saved revision; historical viewing remains isolated; opening latest behaves correctly. |
| Persistence | Declared saved state survives reopening; source revisions preserve or deliberately migrate it. |
| Spatial behavior | One appropriate exemplar demonstrates real part manipulation and newly authored behavior, not only camera motion or a prerecorded animation. |
| Conventional UI | An ordinary UI works through the same App pipeline without a spatial requirement. |
| Browser evidence | A signed-in real-agent journey confirms the integrated behavior on the intended deployment. |

Unit tests and fixture browser journeys can establish local behavior. They do not replace the signed-in real-agent journey. Do not mark unrun checks complete. Implementation updates should identify what changed, which checks ran, and what remains unverified.

## 7. Historical audit record

The initial investigation inspected Theorem `a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704`, Theorem-UI `5ee9b58822454cc26fa163baff78f1dd0794ec8e`, and Platinum `4724f7deec972b29f47febf39117655ddbfce0e9`. A later App source trace used UI `35cf1e40ddd347a5ce285efa102d913aef37ed8c`. Those are historical evidence pins, not statements of the latest deployed versions.

At the initial pins, SceneOS already had substantial Luma rendering, authored behavior, durable scene message parts, and a chromeless inline SceneCard. The specialized explanation path nevertheless constrained shape/layout and behavior. These findings justify reusing useful code while choosing ordinary App source as the broader authoring authority. Historical `show_scene` registration and authoring guidance are descriptive evidence only and are superseded as active recommendations by this plan.

The initial SceneOS web audit passed all five headless groups, including 198 reported explanation/runtime checks, type checking, and a rebuild that matched the committed bundle bytes. The matching bundle SHA-256 was `26ceaabb5451f26a0727ed3b73f4ee192e2963cebbed1c304a5d3f853fe174ca`. These checks apply only to that old SceneOS baseline. They did not verify the current App corrections or a signed-in real-agent/GPU journey.

The read-only audit preserved dirty shared checkouts. Their divergence from remote main did not establish which version served the running product. An unauthenticated 401 from the scene host established an authentication boundary, not a host failure.

At the audited Platinum revision, transcript artifacts had a fallback/Open action; Theo's particles were presence rendering, and the Servo scene file was a texture bridge. No complete inline native artifact consumer was established. The old particle branches were separate presence/fixture work. Native continuity can follow the web path; reviving retired frontend packaging is not part of this correction.

Historical source references:

- [Scene authoring guidance at the audited baseline](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/scene.md)
- [Scene operation and receipt](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/agent/src/operations/scene.rs)
- [SceneOS implementation record](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/CRATE.md)
- [Historical inline SceneCard](https://github.com/Travis-Gilbert/Theorem-UI/blob/5ee9b58822454cc26fa163baff78f1dd0794ec8e/src/components/chat/scene-part.tsx)
- [Native transcript artifact handling](https://github.com/Travis-Gilbert/Platinum/blob/4724f7deec972b29f47febf39117655ddbfce0e9/src/theorem/transcript.rs)
- [Generalized procedural-engine handoff](https://chatgpt.com/library?file_id=libfile_1135d3399d548191a12879a3ba431277&account_id=personal), retained as design context rather than a required authoring format
