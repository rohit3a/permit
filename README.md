# Permit

Permissions without the pain, as a Claude Code mod. When auto mode blocks a tool call, Permit asks you right away instead of leaving a dead end. Trust profiles switch a group of commands on for a while, a short hard floor refuses the never-do actions outright, and one pane holds every rule and setting.

It runs in the terminal and in the Claude desktop app (Code tab), on Linux and macOS. It needs a Claude Code build with function hooks: 2.1.280 or later.

## Install

1. Some builds, 2.1.280 among them, keep function hooks behind a switch. Add this to the `env` block of `~/.claude/settings.json`:

   ```json
   "env": {
     "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
   }
   ```

2. Add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add rohit3a/permit
   ```

   ```bash
   claude plugin install permit@permit
   ```

3. Start a new session, in the terminal or the desktop app. `/permit` opens the pane.

To update: `claude plugin marketplace update permit`, then `claude plugin update permit@permit`, then start a new session.

## What it does

- **Ask instead of block.** When auto mode blocks a call, you get a question card: allow it once, for this session, or always. Blocks you skip wait in the band above the prompt and in the pane.
- **Rules.** `/permit allow "vercel env *" 2h` allows a pattern for a while. A Bash pattern covers one simple command; anything chained onto it (`;`, `&&`, a pipe) still goes through the usual checks.
- **Trust profiles.** A named group of rules switched on for a while: `secrets`, `desktop`, `deploy`, `ops`, `mail` and `all`. You can add rules to them, or add profiles of your own, in `config.json` (below).
- **Hard floor.** A short list that is refused whatever else allows it: printing a secret into the chat, touching Claude's own login, `rm -r` on `/` or a home folder, force-pushing main, sudo password workarounds, powering off or suspending the machine, and reading the clipboard while a copied secret is on it. It is always on and sees through rewordings: `git -C dir push`, `sudo`, `env` and `timeout` wrappers, `bash -c '…'`, `feature:main` refspecs, and a bare `git push -f` while main is checked out. `/permit floor` lists it.
- **Floor approvals.** Force-pushing main, powering off, and stopping what must keep running can be let through once, when you approve that exact command on a device of your own (below). The rest of the floor is never let through.
- **Secrets to the clipboard.** The `secret_to_clipboard` tool copies a key to the clipboard after you approve it, so Claude never sees the value. Sources: a [VaultOS](https://github.com/rohit3a/vaultos) project (through `vaultos-agent`), a Vercel project's environment (through `vercel env pull`), or a `.env` file. The clipboard clears after 120 seconds. It uses `pbcopy` on a Mac and `wl-copy`, `xclip` or `xsel` on Linux.

Shell commands are read the way bash reads them, heredocs included: text under a quoted heredoc (`<<'EOF'`) runs nothing, so it never trips the floor, while a heredoc fed to a shell is checked line by line.

## Floor approvals

Some floor checks are there for when you have not asked, not to stop you: force-pushing main (`force-main`), powering off or suspending (`power`), and stopping what must keep running (`keep-alive`). If an approval service runs on the machine, Permit can let one of these through once you approve that exact command on a device of your own:

1. The floor refuses the call and Permit files a request with the service: the check, the exact command, the directory and the session. Claude is told the request is waiting and not to reword it.
2. You approve or deny it on your device. Within a few seconds Permit tells the session, which runs the exact same command again (approved) or does not (denied).
3. On that run Permit spends the approval and lets the command through. A deny rule in your settings still wins. One approval is one run, within 30 minutes; any other text, directory or session needs its own.

Nothing a session can write decides a request: Permit never reads an approval from `data.json`, `config.json`, the chat or a tool result, only from the service. The service must listen on `127.0.0.1:47800` as root (Permit checks `/proc/net/tcp`, so this is Linux only), and it accepts decisions only from your own devices. Without one, every floor check stays final. Printing secrets, the clipboard, Claude's login, sudo password workarounds and `rm -r` on home are never put to the service. Approving runs the whole command as you saw it, anything chained onto it included.

The service speaks JSON over HTTP, from this machine only:

| Request | What it does |
| --- | --- |
| `POST /v1/permit/requests` `{floor, title, command, cwd, session, agent}` | The live request for this command, directory and session (waiting, approved and unspent, or recently denied), or a new waiting one |
| `GET /v1/permit/requests/<id>` | Where a request stands |
| `POST /v1/permit/requests/<id>/use` | Spends an approval on its one run; refused unless approved, unspent and recent |

Each answers `{id, state, used, note}`, `state` being `pending`, `approved`, `denied`, `expired` or `withdrawn`. Decisions reach the service from your devices by whatever path it trusts; Permit never sends one.

## Your machine's additions: config.json

Permit reads `~/.claude/permit/config.json` (under `$CLAUDE_CONFIG_DIR` when that is set) if it is there. You write it by hand and Permit never writes it. It can only add: more protection, and rules for profiles you switch on yourself.

```json
{
  "protect": ["/srv/backups"],
  "keepAlive": ["slack", "my-agent.service"],
  "vaultCommand": "vaultos-agent",
  "profiles": [
    { "name": "ops", "rules": [{ "tool": "Bash", "match": "mytool *" }] },
    { "name": "staging", "icon": "🧪", "title": "Staging", "blurb": "Deploys to staging", "maxHours": 4,
      "rules": [{ "tool": "Bash", "match": "./deploy.sh staging *" }] }
  ]
}
```

| Key | What it adds |
| --- | --- |
| `protect` | Paths `rm -r` may never take, beside `/`, `~` and home folders |
| `keepAlive` | Apps and services that must keep running: `systemctl stop`, `pkill` and `killall` on a name containing one of these (any case) are refused |
| `vaultCommand` | The VaultOS command `secret_to_clipboard` runs, if not `vaultos-agent` |
| `floorApprovals` | Narrows which floor checks may be approved: a list of `force-main`, `power`, `keep-alive`, or `false` for none. It can never add a check |
| `profiles` | A profile named like a built-in adds its rules to that one; a new name adds a profile |

Changes land within half a minute. If the file stops being valid JSON, Permit keeps what it last read from it and says so in `/permit floor`.

## Commands

| Command | What it does |
| --- | --- |
| `/permit` | Opens the pane |
| `/permit allow <pattern> [when]` | Allows a pattern; `when` is `once`, `session`, `30m`, `2h`, `1d` or `always` (the default) |
| `/permit trust <profile> [2h\|off]` | Switches a profile on for a while |
| `/permit untrust <profile>` | Switches it off |
| `/permit off` | Switches everything temporary off: profiles, session rules and timed rules |
| `/permit revoke <id or pattern>` | Removes one of your rules |
| `/permit approve` | Allows the latest block once |
| `/permit rules`, `/permit log`, `/permit floor` | Lists them |
| `/permit demo [clear]` | Fills the pane with sample data to look at; demo rules never allow anything |

Its options (asking on blocks, how long a secret stays on the clipboard) are listed by `claude plugin configure permit@permit`. The hard floor has no off switch, since a session could flip one in your settings.

## Where it keeps things

Rules, profiles switched on, blocks and the log are in `~/.claude/permit/data.json` (under `$CLAUDE_CONFIG_DIR` when that is set). Every session on the machine reads and writes that one file, whether it runs in the terminal or the desktop app. Permit replaces the file whole on each write. If the file ever stops being valid JSON, Permit saves nothing until it is fixed or removed.

## Development

The plugin is in `plugins/permit`: `hooks/register.tsx` holds every hook, and `view.tsx`, `rules.ts`, `approvals.ts`, `secrets.ts` and `shell.ts` hold what needs no `$`. Keep every function that takes `$` in `register.tsx`, since older builds refuse `$` passed across imports.

```bash
claude plugin validate plugins/permit
```

```bash
claude plugin test plugins/permit
```

`tsc -p plugins/permit` type-checks against the declarations the engine writes to `plugins/permit/.claude-plugin/types/` when it loads the mod. That folder is not checked in.

A marketplace added from a local clone (`claude plugin marketplace add /path/to/permit`) still installs a copy under `~/.claude/plugins/cache/permit/permit/<version>/`, which the desktop app loads. To try a change there, bump `version` in `plugins/permit/.claude-plugin/plugin.json` and run the two update commands above.

## License

MIT, see [LICENSE](LICENSE).
