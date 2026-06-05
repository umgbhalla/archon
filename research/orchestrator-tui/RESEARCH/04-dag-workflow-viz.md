# DAG / Workflow / Graph Visualization for Agentic Workflows

Research date: **2026-06-05**. Focus: how visual builders and run inspectors **visualize a running multi-step / multi-agent workflow** (node graph, timeline, trace tree, swimlanes), with an eye to ideas transferable to a **terminal orchestrator TUI**.

Recency flag legend: 🟢 active (touched within ~3 months) · 🟡 aging · 🔴 stale / maintenance mode (>6 months untouched or officially frozen).

---

## Summary table

| Tool | Repo (URL) | Stars (approx) | Last release / activity | UI paradigm | Recency |
|---|---|---|---|---|---|
| LangGraph | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | ~34k | v1.2.4, 2026-06-02 | Framework (renders graph via Studio) | 🟢 |
| LangGraph / LangSmith Studio | langchain-ai/langgraph-studio (now LangSmith Studio, hosted) | n/a (closed UI) | Active 2026 | DAG + web dashboard + IDE | 🟢 |
| LangSmith (traces) | hosted, [docs](https://docs.langchain.com/langsmith) | n/a | Active 2026 | Trace tree + waterfall web dashboard | 🟢 |
| Langflow | [langflow-ai/langflow](https://github.com/langflow-ai/langflow) | ~149k | v1.9.6, 2026-06-02 | DAG visual builder (web) | 🟢 |
| Flowise | [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | ~53k | flowise@3.1.2, 2026-04-14 | DAG visual builder (web), AgentFlow V2 | 🟢 |
| CrewAI (+ Flows) | [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | ~53k | v1.14.6, 2026-05-28 | `flow.plot()` static HTML DAG + Enterprise trace dashboard | 🟢 |
| AutoGen / AutoGen Studio | [microsoft/autogen](https://github.com/microsoft/autogen) | ~59k | python-v0.7.5, 2025-09-30 | Drag-drop team builder + message-flow web UI | 🔴 maintenance mode |
| n8n (AI Agent node) | [n8n-io/n8n](https://github.com/n8n-io/n8n) | ~191k | v2.23.3, 2026-06-04 | DAG canvas + Executions panel (web) | 🟢 |
| Temporal (Web UI) | [temporalio/temporal](https://github.com/temporalio/temporal) | hosted UI | Active 2026 | Event-history list + Timeline (swimlane) web | 🟢 |
| Restate | [restatedev/restate](https://github.com/restatedev/restate) | active | Active 2026 | Invocation-state dashboard (basic) | 🟢 (viz immature) |
| Dagster | [dagster-io/dagster](https://github.com/dagster-io/dagster) | ~13k+ | Active 2026 | Asset DAG + Run Gantt + global timeline (web) | 🟢 |
| Prefect | [PrefectHQ/prefect](https://github.com/PrefectHQ/prefect) | active | Active 2026 | Per-task run tracking (web, task-centric) | 🟢 |
| Rivet | [Ironclad/rivet](https://github.com/Ironclad/rivet) | ~4.6k | v1.11.3, 2025-08-08 | Node-graph desktop IDE + live remote debugger | 🟡 (~10mo since release) |
| graphs-tui | [decisiongraph/graphs-tui](https://github.com/decisiongraph/graphs-tui) | small | 2025 | TUI: Mermaid/D2 → Unicode/ASCII DAG | 🟡 |

---

## Detailed findings

### LangGraph + LangGraph Studio (now LangSmith Studio)
- **Repo:** https://github.com/langchain-ai/langgraph — ~34k stars, v1.2.4 (2026-06-02), 🟢 very active (99.6% Python, MIT). Tagline now: "low-level orchestration framework for long-running, stateful agents."
- **UI paradigm:** DAG-or-graph, web dashboard, also IDE-embedded (VS Code extensions exist). Studio is "the first agent IDE."
- **What it visualizes:** Auto-renders the agent graph (nodes `start/agent/action/end`, edges) from the code definition. Right pane shows JSON state. During a run it **streams real-time step info** — you watch the agent decide a tool, call it, loop.
- **Orchestration model:** Stateful graph with conditional edges, cycles, supervisor/subagent patterns; durable execution + human-in-the-loop interrupts.
- **Run inspector / key ideas worth stealing:**
  - **Step-through "debug mode"** — pause after each node, walk the graph step by step.
  - **State manipulation + node replay** — edit the state (or the underlying code) at a step and re-run that node to simulate alternate outcomes (time-travel debugging).
  - Caveat noted in docs: undefined conditional edges render as edges to *all* nodes — cluttered. Lesson: a TUI graph should only draw edges it can prove, or mark speculative edges differently.
- Sources: [blog.langchain.com Studio](https://blog.langchain.com/langgraph-studio-the-first-agent-ide/), [DeepWiki graph visualization](https://deepwiki.com/langchain-ai/langgraph-studio/5.2-graph-visualization), [LangSmith Studio docs](https://docs.langchain.com/langsmith/studio).

### LangSmith run traces
- **Paradigm:** Web dashboard, **trace tree + waterfall** — the canonical run-inspector pattern.
- **What it visualizes:** Runs = OTel-style traces/spans. A root run ("handle user message") with nested child runs (LLM call, retriever, tool, parser, router, validator). The **Details tab shows the full run tree**; the **waterfall view** overlays sequence + timing per span so loops, stalls, and hot paths pop out. Errors render as a **red span** with full input/output + traceback inline.
- **Key ideas worth stealing:**
  - **Tree + waterfall duality** — same data, two views: hierarchy (causality) and timeline (timing). A TUI can offer a collapsible step tree and a toggle to a span-timeline.
  - **Color-coded error spans** that jump in the hierarchy; click a span to inspect inputs/outputs/tokens/timing.
- Sources: [LangSmith tracing deep dive](https://medium.com/@aviadr1/langsmith-tracing-deep-dive-beyond-the-docs-75016c91f747), [statsig](https://www.statsig.com/perspectives/langsmith-tracing-debug-llm-chains).

### Langflow
- **Repo:** https://github.com/langflow-ai/langflow — ~149k stars (largest in class), v1.9.6 (2026-06-02), 🟢. DataStax/IBM-backed. Python-based, source access per component.
- **UI paradigm:** DAG visual builder (web). Supports conditional edges, cycles, state — closer to real multi-agent orchestration than Flowise. Can deploy any flow as an **MCP server**.
- **What it visualizes:** Graph of components; **interactive Playground** with **step-by-step control** to watch the flow execute and inspect each stage's output in real time.
- **Key idea worth stealing:** Playground = build canvas + live run inspector in one surface, with per-node output drill-down.
- Sources: [GitHub](https://github.com/langflow-ai/langflow), [MAG comparison 2026](https://madappgang.com/blog/open-source-visual-agent-builders-compared-flowise-vs-langflow-vs-n8n-vs-sim-studio-in-2026/).

### Flowise
- **Repo:** https://github.com/FlowiseAI/Flowise — ~53k stars, flowise@3.1.2 (2026-04-14), 🟢. Node.js/TypeScript. Acquired by Workday.
- **UI paradigm:** DAG drag-and-drop (web). Three modes: Assistant, Chatflow (single agent), **AgentFlow V2** (multi-agent).
- **What it visualizes:** AgentFlow V2 (2025) = native workflow engine on a visual canvas with **Agent / Tool / Condition / Loop / Human-in-the-Loop** nodes — notably the only native **approval-gate** node in this group.
- **Orchestration model:** Multi-agent orchestration with explicit Condition/Loop control-flow nodes and HITL gates.
- **Key idea worth stealing:** First-class **node types for control flow** (Condition, Loop) and **HITL approval gate** as a visible node — a TUI can render approval-pending steps as a distinct, blocking node state.
- Sources: [GitHub](https://github.com/FlowiseAI/Flowise), [aiagentsarena 2026](https://aiagentsarena.com/flowise-vs-langflow-best-visual-ai-agent-builder-in-2026/).

### CrewAI + Flows
- **Repo:** https://github.com/crewAIInc/crewAI — ~53k stars, v1.14.6 (2026-05-28), 🟢. Independent of LangChain. ~450M agents/month, used by 60% of Fortune 500 (per 2026 vendor claims).
- **UI paradigm:** Two layers — **`flow.plot()`** generates a **static interactive HTML DAG** of all steps/listeners/routing (zoom, hover for details); **Enterprise Control Plane** is a real-time web trace dashboard.
- **What it visualizes:** `plot()` shows nodes (tasks) + directed edges (execution flow) and **updates automatically as you edit the flow code** — designed to catch routing/logic errors *before* spending API budget. Control Plane: per-step token usage, per-crew latency, every LLM/tool/memory call with cost accounting, reversible.
- **Orchestration model:** Crews (autonomous role-playing agent teams) + Flows (event-driven/conditional scripted workflows with `@listen`/`@router`).
- **Key idea worth stealing:** **Pre-flight DAG preview from code** — render the planned graph statically before any execution, so the operator sees the plan and catches dead branches early. Per-step **cost accounting** baked into the trace.
- Sources: [CrewAI Flows docs](https://docs.crewai.com/en/concepts/flows), [Markaicode 2026](https://markaicode.com/crewai-flows-event-driven-agent-orchestration/), [W&B Weave tracing](https://wandb.ai/onlineinference/genai-research/reports/Tracing-your-CrewAI-application--VmlldzoxMzQ5MDcwNA).

### AutoGen / AutoGen Studio — 🔴 MAINTENANCE MODE
- **Repo:** https://github.com/microsoft/autogen — ~59k stars, last release **python-v0.7.5 (2025-09-30)** — **no new features**, community-managed. Microsoft directs new users to **Microsoft Agent Framework (MAF) 1.0**. Flag: not meaningfully advanced in ~8 months.
- **UI paradigm:** No-code/low-code web GUI; **drag-and-drop team builder**; message-flow visualization.
- **What it visualizes:** Maps **agent-to-agent message paths and dependencies**; real-time agent action streams (async event messages); profiling viz (how often tools/code ran). Mid-execution control: pause, redirect, adjust team composition, resume.
- **Orchestration model:** Agent **teams** (declarative JSON or drag-drop). Architectural shift in successor MAF: from implicit "GroupChat manager picks next speaker" → explicit **graph-based workflows with typed nodes/edges**.
- **Key ideas worth stealing:**
  - **Message-flow / swimlane view** of inter-agent communication (who-talked-to-whom) — distinct from a step DAG.
  - **Mid-run team mutation** — pause, change composition, resume.
- Sources: [GitHub](https://github.com/microsoft/autogen), [MS Research v0.4](https://www.microsoft.com/en-us/research/blog/autogen-v0-4-reimagining-the-foundation-of-agentic-ai-for-scale-extensibility-and-robustness/), [Starlog maintenance-mode](https://starlog.is/articles/ai-agents/microsoft-autogen/).

### n8n (AI Agent node)
- **Repo:** https://github.com/n8n-io/n8n — ~191k stars (highest here), v2.23.3 (2026-06-04), 🟢. TypeScript, fair-code.
- **UI paradigm:** DAG canvas (web) + **Executions panel** + per-node inline logs.
- **What it visualizes:** AI Agent rendered as a node with extra connections (chat model, vector store, tools as sub-workflows). Internally a ReAct/function-calling loop. **Execution Log records each tool call, model output, intermediate state**; per-node outputs inspectable; pair with Langfuse/Helicone for token/latency/error traces.
- **Orchestration model:** Workflow graph mixing AI steps with deterministic nodes; tools = sub-workflows or HTTP.
- **Key idea worth stealing:** **Per-node output inspection on the same canvas** — click a node post-run, see its exact I/O; "Execute Workflow" manual run with visible per-node results (good for a TUI focus-node detail pane).
- Sources: [GitHub](https://github.com/n8n-io/n8n), [n8n AI Agent docs](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/).

### Temporal (durable workflow) — strongest timeline model
- **UI paradigm:** Web Event-history list + dedicated **Timeline view** (swimlane-style).
- **What it visualizes:** The **Timeline** plots events in time. Uses **Event Groups** — `ActivityTaskScheduled/Started/Completed` collapse into a **single Activity row spanning the duration**. First row = the whole workflow execution (total duration). **Color = outcome** (green Completed, red Failed). Hover tooltip = exact start/end + ms duration. Single events (Markers, Signals) render as points. Crucially shows **compensation activities** that ran after a failure.
- **Orchestration model:** Durable execution, retries, timers, signals, queries; "survives the apocalypse."
- **Key ideas worth stealing (most directly TUI-applicable):**
  - **Event grouping** — collapse N raw events into one labeled span row spanning its duration. Essential for a clean TUI: don't show every raw log line, group into step-spans.
  - **Color-coded outcome + the root row showing total duration** as a reference scale.
  - **Show compensation/retry spans inline** so recovery is visible, not hidden.
- Restate by contrast (https://github.com/restatedev/restate) is active but its dashboard only shows **service invocations + states** — no comparable timeline. Lesson: timeline introspection is a differentiator.
- Sources: [Temporal Timeline View blog](https://temporal.io/blog/lets-visualize-a-workflow), [Temporal review 2026](https://digitalbydefault.ai/blog/temporal-workflow-orchestration-review-2026), [durable-execution comparison 2026](https://devstarsj.github.io/2026/04/03/durable-execution-temporal-restate-dbos-distributed-workflows-2026/).

### Dagster / Prefect (DAG UI inspiration)
- **Dagster:** ~active 🟢. Run details page = **Gantt chart (upper-left)** showing how long each asset/op took + **bottom pane of filterable events/logs**, plus a separate global **run timeline**. Strong convention worth stealing: **horizontal = elapsed time** consistently across the UI (timeline + Gantt), now even an experimental horizontal asset-DAG layout. Asset graph explorer + lineage.
- **Prefect:** 🟢. **Dynamic Pythonic** model — the graph is built **at runtime**, not parse time (flows can contain arbitrary if/for/try). UI is **per-task run tracking**, more task-centric, lighter, lacks native lineage.
- **Key idea worth stealing:** Dagster's **Gantt + synchronized log pane** layout (top: timing bars; bottom: filterable event stream tied to selection). And the **horizontal-axis-is-always-time** discipline.
- Sources: [Dagster webserver/UI docs](https://docs.dagster.io/guides/operate/webserver), [Dagster run viz DeepWiki](https://deepwiki.com/dagster-io/dagster/7.4-run-and-event-interfaces), [Airflow vs Dagster vs Prefect 2026](https://dev.to/datastackx/airflow-vs-prefect-vs-dagster-picking-the-right-orchestrator-in-2026-1ifb).

### Rivet (Ironclad)
- **Repo:** https://github.com/Ironclad/rivet — ~4.6k stars, **v1.11.3 (2025-08-08)** 🟡 (~10 months, slowing). MIT, TypeScript. `@ironclad/rivet-core` / `-node` embeddable.
- **UI paradigm:** Blender-style **node-graph desktop IDE** — nodes with input/output ports connected by wires; data flows along wires; graphs start at no-input nodes, end at no-output nodes.
- **What it visualizes:** The prompt/agent graph, plus a **remote debugger that observes live prompt-chain execution inside a running application in real time** (your deployed app calls Rivet graphs; the IDE watches).
- **Recent features:** AI Graph Creator (CMD+I to generate/edit graphs), MCP support, **Project References** (use a graph as a library in another), **Auto Layout** (auto-arrange nodes), Claude Opus/Sonnet 4 + Gemini 2.5 support. YAML graph storage.
- **Key ideas worth stealing:**
  - **Remote live debugger** — the viz tool attaches to a *separately running* execution and streams node activity. Maps perfectly to a TUI that attaches to a running orchestrator daemon.
  - **Auto Layout** — one-keypress graph arrangement (a TUI DAG must auto-layout; humans won't position nodes).
  - **Graph-as-library references** — subgraph reuse → render nested/collapsible subgraphs.
- Sources: [GitHub](https://github.com/Ironclad/rivet), [releases](https://github.com/Ironclad/rivet/releases), [BrightCoding deep dive 2025](https://www.blog.brightcoding.dev/2025/09/12/building-autonomous-agents-with-visual-prompt-chaining-a-deep-dive-into-rivet/).

### TUI DAG renderers (the terminal-native angle)
- **graphs-tui** (https://github.com/decisiongraph/graphs-tui) 🟡 — renders **Mermaid and D2 diagrams** (flowcharts, state diagrams) to **Unicode/ASCII** in the terminal. Closest off-the-shelf "DAG in a terminal" primitive — you can express the workflow as Mermaid and let it lay out nodes/edges.
- **Framework primitives for building it yourself:**
  - **Ratatui (Rust)** — Canvas widget + **Braille markers** (U+2800–U+28FF, 2×4 dot grid = 8 sub-pixels/cell) for high-density span bars; box-drawing for node boxes/edges; charts/sparklines/gauges. Fallback to block chars (▁▂▃▄▅▆▇█) when Braille unsupported.
  - **Textual (Python)** — `Tree` widget for the run hierarchy; widget/layout system for split panes (graph pane + detail pane).
  - **gotui / termui (Go)** — TreeMap + Braille/Block plots.
- **Braille technique** is the key trick for **sub-character-resolution Gantt span bars** in a terminal (sub-cell timing precision without more columns).
- Sources: [awesome-tuis](https://github.com/rothgar/awesome-tuis), [Ratatui](https://ratatui.rs/), [graphs-tui](https://github.com/decisiongraph/graphs-tui), [Real Python Textual](https://realpython.com/python-textual/).

---

## Cross-cutting patterns (what nearly everyone does)
1. **Two coupled views of one run:** a **structure/tree** view (causality, who-called-what) and a **timeline/waterfall** view (timing). LangSmith, Temporal, Dagster all do this.
2. **Spans, not raw events:** collapse related events into one labeled span/row spanning its duration (Temporal Event Groups; LangSmith spans).
3. **Color = status, click = detail:** green/red/running spans; selecting a node opens an I/O + tokens + error detail pane (LangSmith, n8n, Dagster).
4. **Horizontal axis = time** as a consistent discipline (Dagster).
5. **Pre-flight static DAG from code** before running (CrewAI `plot()`); **auto-layout** because no one hand-positions nodes in a TUI (Rivet).
6. **Attach to a live, separately-running execution** and stream updates (Rivet remote debugger, LangGraph streaming, AutoGen action streams).
7. **HITL / approval as a visible blocking node state** (Flowise HITL gate, LangGraph interrupts).

## Recency flags
- 🔴 **AutoGen / AutoGen Studio**: officially maintenance mode, last release 2025-09-30. Mine for ideas (message-flow swimlanes) but don't track as a moving target.
- 🟡 **Rivet**: last release 2025-08-08 (~10 months) — still the best node-graph + live-remote-debugger reference, but slowing.
- 🟡 **graphs-tui**: small/niche, 2025.
- 🟢 Everything else (LangGraph, Langflow, Flowise, CrewAI, n8n, Temporal, Dagster, Prefect, Restate) is actively shipping in 2026-H1.

---

## 3-sentence summary (best ideas transferable to a terminal orchestrator)
Pair a **collapsible step/agent tree** (causality, à la LangSmith run tree) with a toggle to a **Temporal-style span timeline** where related events collapse into single duration-bars, the root row shows total runtime as a scale, and color encodes status (green/red/running) — rendered in the terminal with Braille sub-cell bars for timing precision. Make every node **selectable to a detail pane** showing inputs/outputs/tokens/cost/errors (n8n + CrewAI cost accounting), keep the **horizontal axis = elapsed time** (Dagster), and surface **HITL/approval steps as distinct blocking node states** (Flowise/LangGraph). Architecturally, the TUI should **attach to a separately-running orchestrator and stream live node updates** with auto-layout (Rivet remote debugger + Auto Layout), and offer a **pre-flight static DAG preview from the plan before execution** (CrewAI `plot()`) so the operator sees the intended graph and dead branches before spending tokens.
