# ATAgent
**Intelligent Agent Framework**
> An agent framework that lets AI control any application

**⚠️ Current Status: Conceptual stage, under design — no working code yet. Discussion and ideas are welcome.**

---

## What Is This

ATAgent is a **lightweight agent framework** (in progress) aimed at developers.

The core idea: developers register the available actions of their application into the framework, and users can then control the app through **text or voice**. The AI handles intent recognition, action matching, and execution.

```
User says: "Add a reminder for tomorrow's meeting"

ATAgent's process:
  1. Understand intent → Add a to-do
  2. Match registered action → add_todo
  3. Extract parameters → content = "tomorrow's meeting reminder"
  4. Execute → Done
```

---

## Why Build This

AI-powered development is an irreversible trend. More people will enter this space, and giving your own projects AI capabilities is a compelling direction — but existing solutions all have clear limitations:

- **LangChain / AutoGen** — Too heavy; built for AI developers, with a high barrier to entry for general developers
- **RPA tools (UiPath / Zapier)** — Enterprise pricing, complex configuration, not developer-friendly
- **AutoHotkey / PyAutoGUI** — Script-driven only; no natural language understanding
- **Apple Intelligence / Copilot** — Closed ecosystems; cannot be embedded into third-party apps

The gap ATAgent aims to fill: **lightweight, embeddable in any application, with developers defining exactly what AI can do.**

---

## Design

### Core Pipeline

```
Text / Voice
     │
     ▼
┌─────────────────┐
│ Intent Parser   │  AI-1: Rule-first + LLM/NLU
│                 │  High-frequency commands → rules; ambiguous intent → LLM
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Action Router   │  AI-2: Orchestration layer
│                 │  Match, rank, and compose from registered Actions
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Executor      │  AI-3: Execution layer
│                 │  Generate execution scripts; drive UI / APIs
└─────────────────┘
         │
         ▼
     Result & Feedback
```

**Advanced mode (continuous voice conversation):**

```
Voice → ASR (FunASR) → Text → Intent Parser → Action Router → Executor → Feedback
```

---

### Action Schema (Draft)

This is the heart of the framework. **Developers configure Actions to tell the AI what the application can do.**

```json
{
  "name": "add_todo",
  "description": "Add a new to-do item",
  "params": {
    "content": "The text content of the task",
    "due_date": "Due date (optional)"
  },
  "trigger": {
    "type": "ui",
    "steps": "Click the + button in the bottom-right, enter content, click confirm"
  },
  "permission": "normal"
}
```

| Field | Description |
|-------|-------------|
| `name` | Unique identifier for the action |
| `description` | Natural language description for the AI — the clearer it is, the more accurate the matching |
| `params` | Parameters required to execute the action |
| `trigger` | Execution method: UI click / API call / script |
| `permission` | Permission level: `normal` / `confirm` / `admin` |

> `description` is the primary signal the Action Router uses for matching. The design spec for this field is still under discussion.

---

### Permission Levels (Draft)

For irreversible operations, the framework plans to offer three-tier permission control:

| Level | Behavior | Use Cases |
|-------|-----------|-----------|
| `normal` | Execute directly | Queries, browsing, adding |
| `confirm` | Requires user confirmation before executing | Deleting, sending, paying |
| `admin` | Requires administrator identity | System config, permission changes |

---

### Visual Management Panel (Draft)

A companion Action management panel is planned:

- Register and edit Actions through a UI — no manual config files needed
- Preview the AI's execution plan before running (debug mode)
- Import/export Action configs for reuse across projects

---

## Roadmap

| Version | Goal | Status |
|---------|------|--------|
| **1.0.0** | Web: Action registration panel + text commands + single-step execution + feedback display | 🚧 Designing |
| **1.5.0** | Web advanced: Multi-step task chains + error recovery + execution history | 📋 Planned |
| **2.0.0** | Desktop: Cross-app control + local LLM support | 📋 Planned |
| **2.5.0** | Voice: FunASR integration + continuous conversation mode | 📋 Planned |
| **3.0.0** | Mobile: Gesture/tap execution + mobile-optimized UI | 📋 Planned |

---

## Get Involved

This project is still in its early conceptual stage. Contributions of all kinds are welcome:

- Open an [Issue](../../issues) to share ideas or raise concerns
- Suggest improvements to the Action schema design
- Describe use cases you think the framework should support

**If you think this direction has value, a ⭐ is the best way to show it.**

---

## License

MIT © ATAgent Contributors
