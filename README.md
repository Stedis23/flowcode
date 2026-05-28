# Flowcode

Orchestration layer for [opencode](https://github.com/opencode-ai/opencode) AI coding agent. Breaks large tasks into sequential stages with quality gates, crash recovery, and interactive conversation.

## Why

AI coding agents work well for small tasks, but struggle with large features — context windows fill up, the agent loses track of what it has done, and there's no way to review intermediate results before proceeding.

This is especially critical for models with smaller context windows. A task that requires reading 20 files, implementing changes, and running tests can easily exceed a 32K or even 128K context limit. The agent starts forgetting earlier instructions, produces inconsistent code, or halucinates.

Flowcode solves this by splitting work into named stages (task definition, analysis, implementation, lint, test, review, summary). **Each stage runs in a fresh opencode session** — the full context window is available for that specific task, with a compact summary of previous stages injected as context. You review results at quality gates between stages and can reject, rollback, or approve before moving on.

## How It Works

```
┌──────────────────────────────────────────────────────┐
│                    FLOWCODE                          │
│                                                      │
│  ┌─────────┐   ┌─────────┐   ┌───────────────┐     │
│  │  Stage 1 │──▶│ Review  │──▶│   Stage 2     │ ... │
│  │ (Task)   │   │  Gate   │   │ (Analysis)    │     │
│  └─────────┘   └────┬────┘   └───────────────┘     │
│                     │                                │
│              Approve / Reject / Rollback             │
└──────────────────────────────────────────────────────┘
```

1. You pick a **flow** (a sequence of stages) and a **model**
2. Flowcode runs each stage via `opencode run` as a subprocess
3. **Interactive stages** (like task definition) let you chat with the agent, choose suggested options, or type your own answers
4. **Automated stages** run independently — implementation, linting, testing
5. **Quality gates** between stages let you approve, reject with comment, or rollback
6. State is saved to `.flowcode/state.json` — if the process crashes, it picks up where it left off

## Quick Start

### Prerequisites

- Node.js >= 18
- [opencode](https://github.com/opencode-ai/opencode) installed globally (`npm install -g opencode-ai`)
- At least one AI provider configured in opencode

### Install

```bash
git clone <repo-url> flowcode
cd flowcode
npm install
npm run build
npm link        # makes 'flowcode' available globally
```

### Run

```bash
cd your-project
flowcode
```

You'll see:
1. **Flow selector** — pick a pipeline (default: 7-stage flow, quick-fix: 3-stage)
2. **Model selector** — pick or search for a model (filtered by provider, scrollable)
3. **Main TUI** — pipeline progress, chat with agent, quality gates

## Flows

Flows are defined in `flowcode.json` in your project root. If the file doesn't exist, flowcode creates a default config with two built-in flows:

### Default Flow (7 stages)

| # | Stage | Interactive | Description |
|---|-------|-------------|-------------|
| 1 | Task Definition | Yes | Chat with agent to define what needs to be done |
| 2 | Analysis | No | Agent analyzes codebase and creates implementation plan |
| 3 | Implementation | No | Agent writes code |
| 4 | Lint | No | Agent runs linters, fixes issues |
| 5 | Testing | No | Agent writes/runs tests |
| 6 | Review | No | Agent reviews all changes |
| 7 | Summary | No | Agent generates final summary |

### Quick Fix Flow (3 stages)

Fast path for small tasks: Task → Fix → Done.

### Custom Flows

Create or edit `flowcode.json`:

```json
{
  "flows": {
    "my-flow": {
      "name": "my-flow",
      "stages": [
        {
          "id": "plan",
          "name": "Planning",
          "interactive": true,
          "skills": ["task-definition"]
        },
        {
          "id": "build",
          "name": "Build",
          "skills": ["implementation"]
        },
        {
          "id": "verify",
          "name": "Verify",
          "skills": ["lint", "testing"],
          "allowReturn": true,
          "returnTo": "build"
        }
      ]
    }
  },
  "maxRetries": 3
}
```

Stage fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique stage identifier |
| `name` | string | required | Display name |
| `interactive` | boolean | false | User chats with agent |
| `skills` | string[] | [] | Skills to load for this stage |
| `allowReturn` | boolean | false | Allow agent to return to a previous stage |
| `returnTo` | string | - | Stage ID to return to |

## Skills

Skills are Markdown files that give the agent instructions for a specific stage. They live in `~/.config/flowcode/skills/` (or `%APPDATA%/flowcode/skills/` on Windows).

Flowcode ships with 7 built-in skills:

| Skill | Description |
|-------|-------------|
| `task-definition` | Guides the agent to ask clarifying questions and define the task |
| `analysis` | Analyzes the codebase and creates an implementation plan |
| `implementation` | Writes code based on the plan |
| `lint` | Runs linters and fixes issues |
| `testing` | Writes and runs tests |
| `review` | Reviews all changes made |
| `summary` | Generates a final summary of all work done |

### Custom Skills

Create a `.md` file in the skills directory:

```markdown
# SKILL: My Custom Skill

## Role
You are a security auditor.

## Rules
1. Check for SQL injection vulnerabilities
2. Verify input validation
3. Review authentication logic

## Completion
When done, respond with:
\`\`\`json
{"action": "complete", "summary": "..."}
\`\`\`
```

Reference it in your flow config: `"skills": ["my-custom-skill"]`.

## Interactive Stages

Interactive stages let you have a conversation with the agent. The agent will suggest numbered options you can select with arrow keys:

```
Agent: What type of documentation do you need?
Choose an option:
  > 1. API Reference
    2. User Guide
    3. Developer Onboarding
    4. Type your own answer...
[↑↓] Navigate | [Enter] Select | [T] Type own answer
```

Select an option with Enter, or press `T` / select "Type your own answer" to write a freeform response.

When the conversation is complete, the agent finalizes the task and the pipeline continues.

## Quality Gates

Between stages (except the last), a quality gate appears:

```
╔══════════════════════════════════════╗
║   QUALITY GATE: Implementation      ║
╚══════════════════════════════════════╝

Summary: Implemented user authentication with JWT tokens
Issues: None found

> Approve — proceed to next stage
  Reject — send back with comment
  Rollback — revert to previous stage
```

- **Approve** — move to the next stage
- **Reject** — re-run the current stage with your feedback
- **Rollback** — go back to the previous stage

## Chat Commands

During interactive stages:

| Command | Description |
|---------|-------------|
| `/skip` | Skip the current interaction |
| `/pause` | Pause the pipeline |
| `/quit` | Stop and exit |
| `@filename` | Reference a project file (autocomplete with Tab) |

## Crash Recovery

Flowcode saves state to `.flowcode/state.json` after every stage. If the process crashes or you close the terminal, running `flowcode` again will detect the incomplete state and offer to resume:

```
╭─────────────────────────────╮
│  Found incomplete flow      │
╰─────────────────────────────╯
Flow: default | Stage: 3 | Status: running

> Resume — continue from where you left off
  Start fresh — discard previous progress
```

## Reports

After each stage, a report is saved to `.flowcode/reports/` in two formats:

- `<stage-id>.json` — machine-readable report with summary, issues, files changed
- `<stage-id>.md` — human-readable Markdown summary

## Project Structure

```
flowcode/
├── src/
│   ├── cli.tsx                # CLI entry point
│   ├── index.ts               # Public API exports
│   ├── config/
│   │   ├── schema.ts          # Zod schemas for all types
│   │   └── loader.ts          # Config/state loading, path helpers
│   ├── core/
│   │   ├── orchestrator.ts    # Flow engine: stage execution, events, quality gates
│   │   └── report.ts          # Report/checklist management
│   ├── opencode/
│   │   └── server.ts          # Subprocess manager (opencode run via worker thread)
│   ├── skills/
│   │   └── loader.ts          # Skill loading from global config
│   ├── tui/
│   │   └── App.tsx            # Full TUI (Ink/React): all screens and components
│   ├── defaults/
│   │   └── skills/            # 7 bundled skill files (.md)
│   └── postinstall.ts         # Copies default skills to global config
├── package.json
└── tsconfig.json
```

### Key Modules

| Module | Responsibility |
|--------|---------------|
| `orchestrator.ts` | Flow execution engine. Runs stages sequentially, emits events for TUI, handles quality gates, interactive mode, crash recovery |
| `server.ts` | Runs `opencode run` as a subprocess in a worker thread. Manages session IDs for conversation continuity, extracts JSON streaming events |
| `App.tsx` | All TUI screens: flow selector, model selector with search, main chat view, interactive options, quality gates, completion summary |

## Configuration Files

| File | Location | Purpose |
|------|----------|---------|
| `flowcode.json` | Project root | Flow definitions and settings |
| `.flowcode/state.json` | Project root | Pipeline state (crash recovery) |
| `.flowcode/model.json` | Project root | Selected model (persisted between runs) |
| `.flowcode/reports/` | Project root | Stage reports (JSON + Markdown) |
| `.flowcode/debug.log` | Project root | Debug log for troubleshooting |
| `~/.config/flowcode/skills/` | Global | User skill files (.md) |
| `~/.config/opencode/opencode.json` | Global | Opencode provider/model config |

## Architecture Decisions

- **`opencode run` subprocess** instead of SDK — the SDK starts a separate server that doesn't inherit the user's active model. Subprocess mode uses the user's actual opencode configuration.
- **Worker thread** for subprocess execution — `spawnSync` blocks the Node.js event loop, freezing the TUI. Running it in a worker thread keeps animations and UI responsive.
- **Session continuity** — interactive stages capture the session ID from the first `opencode run` response and pass `--session <id>` to subsequent calls, so the agent remembers the conversation.
- **`--dangerously-skip-permissions`** — opencode requires TTY confirmation for file operations. This flag auto-approves permissions in non-interactive subprocess mode.
- **Ink (React for CLI)** — TypeScript-native, declarative TUI with proper component lifecycle and hooks.

## Development

```bash
npm install
npm run build       # compile TypeScript + copy skills
npm run dev         # run with tsx (no build needed)
npm link            # install globally for testing
```

## Requirements

- Node.js >= 18
- opencode >= 1.15 (with at least one AI provider configured)
- Windows or macOS (Linux should work but not tested)

## License

MIT
