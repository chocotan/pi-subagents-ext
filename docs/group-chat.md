# Group chat rooms

For users who want several experts in one hosted conversation. While chat is **on**, this Pi session is the host: bare text reaches the main model, which `room_tell`s / `handoff`s seats. `@handle` still wakes a seat directly. Agent mentions outside a room stay in [README](../README.md#agent-mentions).

A room is a seat list plus a shared log bound to **this session**, not the project cwd.

Rooms are disabled by default. Set `"roomsEnabled": true` in the global or project `subagents.json`, or enable `/agents → Settings → Rooms`, then reload Pi. When disabled, room tools and `/chat` / `/room` commands are not registered, and saved bindings do not route input or add host instructions. Room files are preserved.

## Mental model

```text
/chat on zbase-dev gateway-dev
  -> .pi/groups/<id>/meta.json + log.jsonl
  -> session entry subagents:room { chat: true, leader: main }

user types (no @)
  -> append to the log
  -> host (main model) runs and may room_tell / handoff

user types @gateway look at the route
  -> append to the log
  -> wake @gateway only; host does not run
```

`group-join.ts` is unrelated: that module batches **completion notifications**. Rooms live in `src/group-chat/`.

## Commands

| Command | Effect |
|---------|--------|
| `/chat on <type> [type...]` | Create/enter a room on **this session**; host = main |
| `/chat off` | Clear the session binding; queued seat work is dropped |
| `/room create <name> <type> [type...]` | Same as chat on, with a display name |
| `/room list` | Rooms on disk; `*` is bound to this session |
| `/room leave` | Same as `/chat off` |
| `/room status` | Binding and seats |

`<type>` is a user-defined agent type (1–6 seats). Duplicate types get numbered seats (`explorer`, `explorer-2`). `/new` turns chat off. `/resume` of the same session restores the binding.

## Mentions inside a room

| Typed | Who runs | Log |
|-------|----------|-----|
| No `@` | Host only | Full user text |
| `@handle` | Matching seats | Full user text |
| `@everyone` | All seats | Full user text |
| `@main` | Host | Full user text |
| `@unknown` only | Host (warning) | Full user text |

`@acp-*` is logged and still routed through `AcpAgent`. Seats are Pi agent types, not ACP processes.

Seat turns are **serial**. A busy seat **queues**; `room_cancel` drops queued work; aborting the running turn is explicit. A failed seat turn retries up to 10 times (2s, 4s, 8s, 16s, then 32s) unless the error is a user stop or a policy refusal. After that budget, `modelFallbacks` in `subagents.json` selects the next model and the budget starts over.

## Persistence

```text
.pi/groups/<roomId>/meta.json
.pi/groups/<roomId>/log.jsonl
```

Who is listening is the session entry `subagents:room`, not a cwd `active.json`.

## Tools

| Tool | Who | Meaning |
|------|-----|---------|
| `RoomEnsure` | Host | Open chat on this session |
| `RoomLeave` | Host | `/chat off` |
| `room_tell` | Host and seats | Wake a seat; does not end the turn |
| `handoff` | Host and seats | Transfer the stage; caller should end the turn |
| `room_cancel` | Host | Drop queued (and optionally abort running) work |
| `room_say` / `room_pass` | Seats | Speak or skip |

Seats do not inherit `Agent`, `AcpAgent`, or bash. Code changes go through the host `AcpAgent`.

Prose that names another seat does **not** wake them.
