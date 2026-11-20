# Direction correction: freely authored, live answer artifacts

**Theorem · November 17, 2026 · Corrected product direction; implementation is being handled separately**

## 1. Authoring authority

The agent authors ordinary TypeScript/TSX source. It can use existing components, compose them, or write new components and behavior during the conversation. The existing App compiler, runtime, state, and revision pipeline should run that source inside the answer.

This revision supersedes this document's earlier proposal for a required part contract, model grammar, or component catalog. It also supersedes the earlier plan's recommendation to make the specialized `show_scene` explanation path the primary authoring route. Those proposals would keep the agent within another host-defined vocabulary, which the user explicitly rejected.

A useful new control, object, simulation, or interaction must be expressible in source without adding a core enum case, registering a new part type, or redeploying Theorem. Ordinary library interfaces remain available when useful; they do not define the outer limit of an artifact.

## 2. The experience to preserve

An answer can contain a live app whose representation suits the question. The person can operate it immediately, discuss what is visible, and ask the agent to change the same artifact. Controls, tables, charts, diagrams, notebooks, and spatial simulations are all valid forms. Not every UI needs three dimensions or particles.

The user's correction about the CPU screenshots remains significant: that particular explanation should offer spatial depth and meaningful direct manipulation. A model might let the person separate an assembly, open a component, change an input at the object, and observe a computed consequence. The agent can author the missing internals or a new interaction on request. These are product behaviors to implement in TSX and supporting modules, rather than reasons to invent another required part format.

Luma particles/cells are a promising way to render that spatial example. They can coexist with meshes, curves, labels, and ordinary controls. A CPU or small adder is an optional demonstration of the desired depth and manipulability, not the product's required subject, renderer, or architecture.

The inline artifact should feel like part of the answer. It should be live on arrival, with restrained framing and discoverable actions. Expansion should enlarge the same running instance. Returning inline should preserve in-frame state, selection, and interaction progress. Saved state and later revisions should continue using the existing App mechanisms.

## 3. Modular and customizable through code

Modularity comes from ordinary modules, props, functions, state, and styles. The following are useful places to separate concerns when an artifact benefits from it; they are not mandatory files, metadata fields, or an artifact taxonomy.

| Concern | Useful separation | Freedom to preserve |
| --- | --- | --- |
| Behavior | Calculations, event handlers, simulations, and domain logic can be extracted into functions or modules. | The agent can write a new operation directly. |
| State | App state can distinguish saved user data from transient animation or view state. | Use the existing App persistence API where persistence is needed; do not require every component to implement a new checkpoint protocol. |
| Rendering | React components can combine DOM, SVG, canvas, GPU views, and imported libraries. | A new shape or presentation does not require a renderer registry addition. |
| Theme | Tokens, CSS variables, style modules, and optional design-system themes can provide a consistent appearance. | An artifact can override or replace its presentation without changing its behavior. |
| Source and reuse | A useful component can remain local source, be extracted into a shared module, or later become a reusable package. | Newly authored code works before any catalog or publishing step. |

Selection and conversational context should reuse the App bridge and source-linked references. DOM source locations already provide a general editing route. A canvas app can optionally publish richer semantic selection when useful; a universal part schema should not be a prerequisite for running it.

## 4. Optional libraries

Use libraries as capabilities that authored source can choose:

- **Luma and other visualization libraries:** rendering and interaction building blocks for appropriate explanations.
- **Astryx and other React UI kits:** reusable controls, layouts, themes, and documentation. Scope their design guidance to the components being used; do not turn library-specific template rules into restrictions on all artifacts.
- **A2UI or similar composition tools:** optional integrations where their model helps. They should not replace direct TSX authoring with a required catalog for every answer.
- **Procedural geometry or portable assets:** useful inputs to a particular app. The earlier procedural-engine handoff remains design context, not a mandatory authoring intermediate representation.

The agent may also write the needed component from scratch. Reuse is a convenience and a quality aid, not an admission test.

## 5. Historical evidence behind the correction

The supplied screenshots showed a planar CPU block diagram formed from small cells, an expanded side panel of controls, and an inline narrated sequence. A third image showed only a fragment of the right-hand presentation; a still image cannot identify the cause. The visible experience did not establish the requested spatial manipulation or on-demand creation of new behavior.

The earlier source audit, pinned to Theorem `a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704`, found 2D rectangle layout, explanation geometry at zero depth, whole-view panning, predefined expansion, and role-based shape selection in the specialized explanation path. Its authored JavaScript interface supplied behavior and values while geometry remained constrained. These are facts about that audited path and revision, not limits of Luma, React, or the current implementation work.

Useful historical sources:

- [Explanation contract](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-core/src/explanation.rs)
- [Role-based geometry](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/cells/geometry.ts)
- [Cell draw and picking shaders](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/cells/luma.ts)
- [Authored behavior interface](https://github.com/Travis-Gilbert/Theorem/blob/a7ea1f19d2a7bf4e5b4b35b8ffa3b0db35a18704/rustyredcore_THG/crates/form-scene/scene/scene-os-web/web/src/explain/source.ts)

The earlier screenshots and audit explain why the previous direction was insufficient. They are not acceptance evidence for the corrections now underway.

## 6. What would demonstrate success

Use an ordinary signed-in conversation on identified backend and frontend versions:

1. The agent creates a useful live artifact by writing TSX, including a component or behavior absent from any supplied examples.
2. The artifact runs directly in the answer. The person changes it through its own controls or direct manipulation.
3. For a spatial example, the person handles meaningful parts and changes an input with a visible computed consequence. Merely rotating a camera is insufficient evidence for direct part manipulation.
4. A follow-up asks for something new. The agent revises the same App source and adds the requested behavior without changing the host application.
5. The person can ask about a selected element and the relevant saved revision/state; optional semantic selection can enrich the question.
6. Expansion, streamed answer updates, and collapse preserve the running instance. Reopening follows the app's declared saved-state behavior.
7. A suitable conventional UI artifact works through the same path, showing that spatial rendering is a choice rather than a universal requirement.

Type checks, bundling, runtime observations, and product interaction should be recorded separately. A completed source edit or a successful bundle is not proof of a successful real-agent journey.

## 7. Implementation brief

Remove the code and prompt restrictions that stop the agent from authoring ordinary TypeScript/TSX artifacts. Reuse the durable App path for compiling, checking, running, revising, and discussing that source. Keep imported UI and visualization libraries optional and let the agent create missing components directly. Make the result live inside the answer and preserve the same instance when expanded.

Use one spatial, directly manipulable example to honor the original Luma ambition, alongside an ordinary UI example. Let those examples expose concrete gaps in the existing pipeline; do not solve them by imposing a new part grammar.

### Companion material

- [Corrected execution plan](https://chatgpt.com/library?file_id=libfile_fde3_f-dbcb31e30b888191bb78641cd80f4f75_6878dc7caa4481919060e74e27ae75e5&account_id=personal)
- [Generalized procedural-engine handoff](https://chatgpt.com/library?file_id=libfile_1135d3399d548191a12879a3ba431277&account_id=personal), retained as historical design context
- User corrections in this conversation, November 17, 2026, are the authority for this revision.
