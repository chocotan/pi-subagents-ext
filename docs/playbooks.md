# Adaptive workflow Playbooks

For users and project authors who want reusable workflow guidance without maintaining JavaScript orchestration scripts.
This guide covers `WORKFLOW.md`, prompt resources, `WorkflowPlaybook`, and confirmed promotion through `WorkflowPlaybookSave`; see [Scripted workflows](workflows.md) for deterministic JavaScript execution.

Workflow tools are disabled by default. Set `"workflowsEnabled": true` in global or project `subagents.json`, or enable `/agents → Settings → Workflows`, then reload Pi to register the Playbook tools and scripted runtime.

## Mental model

An adaptive Playbook is Markdown guidance for the main coordinator AI. It describes the outcome, useful perspectives, evidence standards, and ways to adapt to the request. It is not a program, a checklist that must always run, or an execution graph.

```text
User request + current conversation + project context
  -> WorkflowPlaybook lists/reads WORKFLOW.md guidance
  -> main coordinator interprets the guidance and current evidence
  -> main coordinator chooses Agent, ordinary tools, skills, and, when explicitly needed, SubagentWorkflow
  -> main coordinator verifies results and synthesizes the answer
  -> WorkflowPlaybookSave promotes generalized Markdown after confirmation
```

The model adapts the guidance. Reading a Playbook does not launch agents, create tasks, or guarantee that every paragraph or prompt resource will be used. There is no separate planner, dependency compiler, generated adaptive JavaScript, or automatic persona/dependency closure.

| Artifact | Responsibility |
|---|---|
| Agent `.md` | One executor's role, tools, model, skills, and system prompt |
| Skill | A reusable specialized capability |
| `WORKFLOW.md` | Markdown guidance for how the main coordinator should reason about and coordinate an outcome |
| `prompts/*.md` | Optional reusable prompt material the coordinator may use, adapt, combine, or omit |
| `WorkflowPlaybook` | Lists and reads Markdown guidance and prompt resources |
| `WorkflowPlaybookSave` | Promotes generalized Markdown and prompt resources after direct confirmation |
| `SubagentWorkflow` | A separate deterministic JavaScript runtime used only when the user explicitly needs scripted control flow |

## Discovery and precedence

A Playbook is a directory containing `WORKFLOW.md`:

```text
.pi/workflows/code-review/WORKFLOW.md
.pi/workflows/code-review/prompts/verify.md
```

Playbooks are loaded with this precedence:

1. `<workspace>/.pi/workflows/<name>/WORKFLOW.md`
2. `<workspace>/.agents/workflows/<name>/WORKFLOW.md`
3. `<agentDir>/workflows/<name>/WORKFLOW.md`

A higher-precedence Playbook replaces a same-named lower one. Project and workspace Playbooks are exposed only when Pi reports the project as trusted; untrusted projects expose global Playbooks only. The `source` argument on `WorkflowPlaybook read` selects an exact source when needed.

Symlinked roots, Playbook directories, `WORKFLOW.md` files, and prompt resources are ignored. Names must be path-safe. Playbooks and prompt output are size-bounded before reading; catalogue output is truncated with an explicit marker. Legacy saved `<name>.js` workflows are a separate catalogue and are not Markdown Playbooks.

## `WORKFLOW.md`

Frontmatter contains stable discovery and display facts. The body is natural-language coordinator guidance:

```markdown
---
name: code-review
description: Adaptively review a code change and return validated findings
execution: adaptive
domains:
  - software-development
  - code-review
side_effects: read-only
approval: adaptive
inputs:
  target:
    type: string
    description: Diff, PR, branch, file, or directory to review
example: Review the current diff with target="HEAD"
---

# Outcome

Review the requested change deeply enough for its actual scope and risk.

# Adaptation

Inspect the target before choosing reviewers. Use one focused Agent call for a
small change; use independent reviewers, ordinary tools, or relevant skills when
the evidence shows broader risk. Verify high-impact findings before reporting.

# Completion

Finish when relevant surfaces are covered and findings have file and line evidence.
```

Supported metadata:

| Field | Default | Meaning |
|---|---|---|
| `name` | Directory name | Stable catalogue identity; it must match the directory name when present |
| `description` | `name` | One-line discovery summary, bounded to 1,000 characters |
| `execution` | `adaptive` | `adaptive` or a metadata-only `deterministic` marker; it does not run anything |
| `domains` | `[]` | Searchable domain labels |
| `side_effects` | `unknown` | Human-readable impact classification |
| `approval` | `adaptive` | Advisory metadata for readers and authors; it is not an authorization rule |
| `inputs` | absent | Documentation for inputs the coordinator may receive |
| `example` | absent | Generalized natural-language invocation example; required for tool-saved Playbooks |

Keep adaptation and completion judgment in the Markdown body. Do not encode a mandatory sequence, conditional routing table, fixed child list, or other programming language in frontmatter. Unknown `execution` or `approval` values cause the Playbook to be skipped with a warning.

## Prompt resources

A Playbook may contain direct `.md` children under `prompts/`:

```text
code-review/
  WORKFLOW.md
  prompts/
    discover.md
    verify.md
    synthesize.md
```

`WorkflowPlaybook read` returns these resources with the coordinator guidance. They are optional source material, not automatically scheduled work. The main coordinator decides whether to use one, adapt it to the current context, combine it with another resource, or omit it.

```markdown
Review {{target}} through the {{lens}} lens.

Known context:
{{context}}

Return only actionable findings supported by file and line evidence.
```

Agent system prompts and Playbook prompt resources remain separate. An Agent `.md` defines who performs work; a Playbook resource helps the coordinator formulate the task for this run.

## `WorkflowPlaybook`

Discover the catalogue:

```json
{ "action": "list" }
```

Filter by name, description, domain, or body text:

```json
{ "action": "list", "query": "review" }
```

Read one Playbook and all readable prompt resources:

```json
{ "action": "read", "name": "code-review" }
```

Select an exact source when precedence hides another copy:

```json
{ "action": "read", "name": "code-review", "source": "global" }
```

The result contains the Playbook metadata, coordinator prompt, and prompt resources. The main coordinator then decides what to do. A read never launches agents or creates tasks.

## `WorkflowPlaybookSave`

Use this tool only when the user asks to save or promote reusable guidance. The main coordinator generalizes task-specific paths, names, platforms, environments, commands, and session details into documented inputs, then submits Markdown guidance and optional prompt resources.

```json
{
  "name": "adaptive-review",
  "scope": "project",
  "description": "Adaptively review a change",
  "body": "# Outcome\n\nReview {{target}} deeply enough for its actual risk.",
  "inputs": {
    "target": { "type": "string", "description": "Change to review" }
  },
  "example": "Review the current diff",
  "prompts": {
    "review": "Review {{target}} through the {{lens}} lens."
  }
}
```

The tool previews the exact destination and complete contents of every proposed file, then calls the direct user confirmation UI. The model cannot assert approval in its arguments. Project scope writes `.pi/workflows/<name>/`; global scope writes `<agentDir>/workflows/<name>/`. The tool does not write `.agents/workflows`, which remains a discoverable workspace location managed outside this promotion flow. Saving fails closed without an interactive/RPC approval UI.

Project saves require a trusted project. Creating an existing name fails without changing files. To update one, first read the exact project or global source and pass `overwrite: true` with the exact `expectedRevision` returned by that read. A stale revision is rejected. The writer validates a temporary directory with the normal loader, uses an owner-only per-target process lock, atomically replaces the whole directory, and retains validated backup/recovery behavior during replacement. Outdated prompt files are removed only after a successful replacement.

Do not save secrets, credentials, run/session IDs, temporary paths, or machine-specific absolute paths. The save tool accepts and emits Markdown files, never generated JavaScript.

## Adaptive use

Use the Playbook as context for the main coordinator, then inspect the actual target before selecting work. For a small change, one focused `Agent` call may be enough. For a broad or risky change, the coordinator may make several independent `Agent` calls, use ordinary `read`/`grep`/`bash` tools, preload or consult skills, or ask a child to verify a candidate finding. The choice is model-driven and evidence-based; the Playbook does not promise a particular number, order, or dependency shape.

A coordinator should:

1. Identify the requested outcome and relevant inputs.
2. Read the target and determine which surfaces and risks are actually present.
3. Choose a proportionate mix of ordinary tools, skills, and Agent calls.
4. Give each child a focused prompt, with the relevant context and evidence standard.
5. Verify important findings independently, by tools or another Agent call when warranted.
6. Synthesize the verified results in the main context, including meaningful uncertainty and coverage gaps.

For deterministic loops, parallel fan-out, pipelines, retries, shell gates, or named JavaScript composition, the user must explicitly ask for `SubagentWorkflow`; see [Scripted workflows](workflows.md). A Playbook may recommend that option, but it does not invoke or compile it automatically.

## Examples

The shipped examples cover the five curated coordination patterns — `code-review`, `deep-research`, `adversarial-review`, `multi-perspective`, and `codebase-audit` — under [`examples/playbooks/`](../examples/playbooks/). Copy one into a project:

```bash
mkdir -p .pi/workflows/code-review
cp -R examples/playbooks/code-review/. .pi/workflows/code-review/
```

Then ask naturally — "review this diff", "research whether X", "audit src/ for missing auth". The main coordinator reads the Playbook, inspects the target, chooses Agent calls, ordinary tools, or skills proportionate to the evidence, verifies findings, and synthesizes the answer. The Playbook directory names (not the pattern shapes) are the catalogue identities: `deep-research` is web research with cross-checked claims, `adversarial-review` is findings challenged by skeptics, `multi-perspective` is independent lenses reconciled, `codebase-audit` is parallel checks cross-validated against the code.

## Boundaries

- Markdown guidance is read by the main coordinator AI; it is not itself executable and not every instruction or prompt resource is necessarily used.
- Playbook metadata describes discovery and intent. It does not authorize external, write, shell, or destructive actions.
- `WorkflowPlaybookSave` promotes generalized Markdown only after direct confirmation; it does not mine journals or generate a JavaScript workflow.
- Promotion supports create/update for project and global Playbooks; delete and rename management are not part of this surface.
- Deterministic JavaScript remains available through the separate `SubagentWorkflow` tool for user-explicit orchestration.
- `workflowsEnabled: false` leaves both Markdown Playbook tools and the scripted runtime unregistered. When enabled, a runtime tool-name collision does not disable the Playbook tools.
