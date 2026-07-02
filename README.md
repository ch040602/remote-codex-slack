# Codex Slack Workspace Bridge

A self-hosted Slack bridge for controlling local Codex CLI workspaces and sessions from Slack.

This project combines two useful patterns:

- The local workspace controller model from `chadingTV/codex-discord`: a chat channel maps to a folder on the same machine where Codex is logged in.
- The Slack thread session model used by Slack Codex bridges: each Slack thread can map to one Codex thread, receive final answers, and continue or rerun work.

No source code from those repositories is copied here. This bridge is also different from OpenAI's official hosted Codex Slack app: this project runs on your machine and invokes the local `codex` CLI against local folders.

## Features

- Bind a Slack channel or Slack thread to a local workspace.
- Change the Codex `cwd` with project aliases or allowed local paths.
- Treat normal messages in a bound channel as Codex session input.
- Start a fresh Codex thread from Slack.
- Send follow-up prompts to the current Codex session.
- Steer an active in-flight turn.
- Resume an existing Codex thread by ID.
- Rerun the last stored prompt.
- Post Codex final answers back to the Slack thread.
- Add Codex skill input items with `$skill-name` references.
- Bootstrap project Slack channels from `config/projects.yaml`.
- Restrict operators with a Slack user allowlist.
- Run Codex through the CLI with the child process `cwd` set to the selected workspace.
- Optionally use the experimental app-server driver.

## Architecture

```text
Slack desktop/mobile
  |-- /codex slash command
  |-- @bot mention
  |-- normal channel message
  `-- !codex message prefix
        |
        v
Codex Slack Workspace Bridge
  |-- Slack Socket Mode
  |-- channel/thread workspace state
  |-- $skill resolver
  `-- Codex CLI process runner
        |
        v
local codex exec -C <workspace> -
        |
        v
local Codex thread / turn / final answer
```

## Requirements

- Node.js 20 or newer.
- Codex CLI installed locally and logged in.
- A Slack app with Socket Mode enabled.
- A Slack bot token.

Check Codex before connecting Slack:

```bash
codex exec --skip-git-repo-check "reply with exactly OK"
```

## Installation

```bash
unzip codex-slack-workspace-bridge.zip
cd codex-slack-workspace-bridge
npm install
cp .env.example .env
cp config/projects.example.yaml config/projects.yaml
cp config/skills.example.yaml config/skills.yaml
```

Windows PowerShell:

```powershell
Expand-Archive .\codex-slack-workspace-bridge.zip
cd .\codex-slack-workspace-bridge
copy .env.example .env
copy config\projects.example.yaml config\projects.yaml
copy config\skills.example.yaml config\skills.yaml
npm install
```

## Slack App Setup

Use Socket Mode. You do not need to expose a public HTTP endpoint or use ngrok.

1. Go to <https://api.slack.com/apps> and create an app.
2. Open **Socket Mode** and enable it.
3. Create an app-level token with the `connections:write` scope.
4. Put that token in `.env` as `SLACK_APP_TOKEN=xapp-...`.
5. Open **Interactivity & Shortcuts** and enable interactivity so command and skill picker menus can send actions back through Socket Mode.
6. Open **OAuth & Permissions** and add the bot token scopes listed below.
7. Install or reinstall the app to your Slack workspace.
8. Copy the bot token into `.env` as `SLACK_BOT_TOKEN=xoxb-...`.
9. Add your Slack user ID to `ALLOWED_SLACK_USER_IDS`.
10. Add the slash command `/codex`.
11. Run `npm run channels:create` to create project channels in that Slack workspace.
12. Run `npm start`.

Minimum recommended bot token scopes:

```text
app_mentions:read
chat:write
commands
channels:history
channels:read
im:history
im:read
groups:history
groups:read
```

Add these scopes only if you want `npm run channels:create` to create and invite users to project channels:

```text
channels:manage
channels:join
groups:write
users:read
```

Slash command settings:

```text
Command: /codex
Request URL: leave any valid placeholder if Slack requires one; Socket Mode delivers the command to Bolt.
Short description: Control local Codex
Usage hint: s | send-mode on|off | ? | $ | pwd | ls | cd <path> | new [-f] <prompt> | send [-f] <prompt> | recent
```

Slack slash commands do not execute inside threads. Use an `@bot` mention or the configured message prefix inside threads.

After a channel is bound to a workspace/session, normal channel messages are treated as `send <message>` only while send mode is on. Send mode defaults to on for backward compatibility, and you can turn it off with `/codex send-mode off` or the `/codex s` button menu. Messages that start with `/` are reserved for Slack slash commands and are not forwarded to Codex by the message listener.

Quick session actions:

```text
/codex s
/codex session
```

This opens a button menu for the current repo/channel:

- `New session`: create and link a new thread for the same cwd/repo.
- `Bind recent`: choose an existing Slack or local Codex CLI session.
- `Unbind`: remove the current session binding while keeping the channel workspace.
- `Send mode on/off`: choose whether normal chat is automatically queued as Codex input.
- `Status` and `Recent`: inspect the current or recent sessions.

On desktop, type `/codex s` and click a button. On mobile, type `/codex s`, send it, then tap the button or picker in the bot response.

## Environment

Edit `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_IDS=U0123456789
SLACK_COMMAND_PREFIX=!codex

CODEX_BIN=codex
CODEX_DRIVER=cli
CODEX_SESSIONS_DIR=%USERPROFILE%/.codex/sessions
CODEX_SANDBOX=workspaceWrite
CODEX_APPROVAL_POLICY=never

PROJECTS_CONFIG=./config/projects.yaml
SKILLS_CONFIG=./config/skills.yaml
STATE_PATH=./data/state.json
STRICT_SKILL_REFERENCES=1
```

Set `ALLOW_ALL_SLACK_USERS=1` only for a private test workspace.

## Codex Driver

Default:

```env
CODEX_DRIVER=cli
```

CLI mode starts real Codex CLI child processes:

```text
codex exec --json --skip-git-repo-check -C <workspace> -
codex exec resume --json <session-id> -
```

The bridge also sets the spawned process `cwd` to the selected workspace. This means Codex runs in the project folder selected by `/codex use --channel`, thread `cd`, or `new --cwd`.

Optional app-server mode:

```env
CODEX_DRIVER=app-server
```

App-server mode starts:

```text
codex app-server --listen stdio://
```

Use app-server mode only if you specifically want the experimental app-server JSON-RPC behavior. CLI mode is the practical default when you want Slack commands to call the same local `codex` executable you use in a terminal.

## Project Configuration

Edit `config/projects.yaml`:

```yaml
baseDirs:
  - "C:/Users/me/work"
  - "/home/me/work"

defaults:
  sandbox: "workspaceWrite"
  approvalPolicy: "never"
  model: ""
  reasoningEffort: ""

projects:
  api:
    path: "api-server"
    default: true

  web:
    path: "web-app"

channelBindings:
  C0123456789: api
```

Rules:

- Relative project paths resolve under the first `baseDirs` entry.
- Absolute paths are allowed only when they are inside one of the configured `baseDirs`.
- If `baseDirs` is empty, any local path is accepted. Use this only for trusted personal setups.
- `npm run channels:create` uses `slackChannelName` when present. Otherwise, it uses the project folder basename; for example, `path: "api-server"` creates or reuses `#api-server`.
- If the desired channel name already exists or two projects map to the same folder basename, the script asks whether to merge into the existing channel or create a suffixed channel such as `#api-server-2`.
- `channelBindings` maps Slack channel IDs to project names.
- A project-level `slackChannelId` also creates a static channel binding.

## Skill Configuration

Edit `config/skills.yaml`:

```yaml
skills:
  test-fixer:
    path: "~/.codex/skills/test-fixer/SKILL.md"
    description: "Investigate and fix failing tests."

  review:
    path: "C:/Users/me/.codex/skills/review/SKILL.md"
    description: "Review changed files and report risks."
```

Use skills in Slack prompts with `$skill-name`:

```text
$test-fixer fix the failing CI tests
!codex send $test-fixer fix the failing CI tests
```

In channels where the bot is present and send mode is on, every normal message is treated as Codex input without `!codex send`. A message that starts with `$skill` is therefore queued as a Codex skill prompt. Send `$` or `$prefix` by itself to open the skill picker. When send mode is off, use `/codex send ...`, `!codex send ...`, or an app mention instead.

To browse local skills from Slack, send `$` or a prefix lookup:

```text
/codex $
/codex $rev
/codex $review inspect this repo
$review inspect this repo
!codex skills test
```

Slack bots cannot open a live popup while you are still typing in the message composer. The bridge therefore implements message-based lookup: send `$`, `$prefix`, or a prompt containing unfinished `$` / `$prefix` to open a skill picker. Choosing a skill replaces that token in the original command and continues the normal queue/run flow.

In CLI mode, the bridge embeds the referenced `SKILL.md` content into the prompt before calling `codex exec`. In app-server mode, the bridge sends Codex input like this:

```json
[
  { "type": "text", "text": "$test-fixer fix the failing CI tests" },
  { "type": "skill", "name": "test-fixer", "path": ".../SKILL.md" }
]
```

When `STRICT_SKILL_REFERENCES=1`, unconfigured `$tokens` fail the command instead of being left as plain text.

## Command Suggestions

Slack bots cannot read message-composer keystrokes before you send a message, so true live inline `$` autocomplete in the normal Slack composer is not available to bot apps. The `/codex` slash command can show Slack's configured usage hint while typing, and the bridge provides Slack-native command and skill picker menus after you send a partial command, typo, or `$` lookup:

```text
/codex ?
/codex commands pend
/codex pend
!codex rerun-s
!codex statu
```

Suggestions follow the current `language en|ko` setting for the channel or thread. If a slash command such as `/codex pend` matches a command prefix, the bridge shows an interactive command menu instead of creating a new channel named `pend`. Selecting a command with no required arguments runs it immediately; selecting a command that needs arguments shows focused usage help.

Skill picker menus work the same way:

```text
/codex $
/codex $rev
/codex new inspect this repo with $
/codex new inspect this repo with $rev
!codex send fix tests with $
```

When a prompt contains `$` or an unfinished `$prefix`, the bridge shows matching configured skills. Choosing a skill replaces that token in the original command and continues the normal flow. Since commands queue by default, choosing a skill in `new` or `send` normally creates a pending command unless you included `-f`.

Normal bound-channel messages also participate in this flow while send mode is on. For example, sending `fix tests with $rev` opens the skill picker for `$rev`; sending `/codex pwd` runs a bot command instead of forwarding `/codex pwd` to Codex.

## Quick Session Actions

Use the shortest flow when you do not want to remember full commands:

```text
/codex s
```

The response includes buttons for `New session`, `Bind recent`, `Unbind`, `Send mode on/off`, `Status`, and `Recent`. `New session` uses the same repo/cwd as the current channel and creates a new Slack thread tied to that workspace. In CLI mode, the Codex session ID appears after the first Codex turn starts. If send mode is on, send a normal message in that new thread to start work; if it is off, use `send <prompt>` or `send -f <prompt>`.

## Running

Default background mode:

```bash
npm start
```

Development foreground mode:

```bash
npm run dev
```

Built foreground mode:

```bash
npm run build
npm run start:fg
```

Windows background controls:

```powershell
npm run win:bg:start
npm run win:bg:status
npm run win:bg:stop
```

`npm start` uses the Windows background launcher by default. Background mode hides the terminal window and writes logs to `data/bridge.log`. It does not create a tray icon; use `win:bg:status` or Slack `/codex pwd` to confirm the bridge is running.

Install a Windows scheduled task for logon startup:

```powershell
.\scripts\windows-install-task.ps1
```

Keep the PC running while you use Slack from another device. The bridge is local: Slack messages reach this process through Socket Mode, and this process starts `codex` on the PC.

## Project Channel Bootstrap

After you create the Slack workspace and install the app, run:

```bash
npm run channels:create
```

The script:

1. Derives a channel name from each project working folder basename unless `slackChannelName` is set.
2. Creates the channel if it does not exist.
3. If the channel name already exists, asks whether to merge into that channel or create a suffixed channel such as `#project-2`.
4. Invites `DEFAULT_INVITE_USER_IDS` from `.env`.
5. Stores the channel ID to project/workspace binding in `data/state.json`.

If you already have channels, skip the bootstrap script and put the channel IDs in `channelBindings` or each project's `slackChannelId`.

## Slack Usage

### Channel Creation And Workspace Browsing

The Slack workspace must already exist. Channels can be created from Slack with the `/codex` command.

Create a new channel:

```text
/codex api-work
```

The bridge creates or reuses `#api-work`, invites configured users, and starts that channel at `CODEX_NAV_ROOT`, which defaults to your Desktop folder.

Explore folders before running Codex:

```text
/codex pwd
/codex ls
/codex cd my-project
/codex ls
```

When you later queue or run a real Codex command, that channel is fixed to the selected workspace and the channel continues one Codex session by default:

```text
/codex new inspect this repository
/codex pending-run 1
```

Create a new channel from a recent session, including its workspace and session binding:

```text
/codex recent
/codex recent --channel api-followup 1
```

This creates or reuses `#api-followup`, binds it to the recent session cwd, and links the session so follow-up commands can continue there.

### PC Workflow

Use this when you are at the machine that runs Codex:

1. Start the bridge in the background:

```bash
npm start
```

2. Open Slack desktop or Slack web.
3. In the project channel, bind the channel once:

```text
/codex use --channel api
```

4. Confirm the active workspace:

```text
/codex pwd
```

5. Browse configured skills when needed:

```text
/codex $
/codex $rev
```

6. Start a Codex task:

```text
/codex new $review inspect this repository and report the next fix
```

7. Continue in the created Slack thread:

```text
!codex send implement the first fix and run tests
```

8. Inspect and rerun recent work:

```text
/codex recent
!codex rerun-session 1 rerun with a shorter final answer
```

The actual Codex process runs on the PC in the selected workspace. Slack is only the control surface.

### Mobile Workflow

Use this when the PC is already on and the bridge is running:

1. Open the Slack mobile app.
2. Go to the project channel.
3. Check that the channel is bound:

```text
/codex pwd
```

4. Browse configured skills when needed:

```text
/codex $
/codex $test
```

5. Start work from the channel:

```text
/codex new $test-fixer fix the failing tests and return the final result
```

6. Open the Slack thread that the bot creates.
7. Send follow-up instructions inside the thread with the prefix, because slash commands do not work inside Slack threads:

```text
!codex send focus on the smallest safe change
```

8. Check recent sessions and rerun one:

```text
!codex recent
!codex rerun-session 2
```

Mobile usage does not require SSH or remote desktop. It does require the PC bridge process to stay online and the bot to be invited to the channel.

Help:

```text
/codex help
!codex help
@YourBot help
```

Bot command explanations default to English. Change them per channel or thread:

```text
/codex language ko
!codex language en
!codex 언어 ko
```

When you run this in a channel, the channel default language changes. When you run it inside a thread, only that thread changes.

List projects:

```text
/codex projects
```

Show the current workspace:

```text
/codex pwd
!codex pwd
```

Bind the current Slack channel to a project:

```text
/codex use --channel api
/codex use --channel=api
```

Change the current Slack thread workspace:

```text
!codex cd web
```

Open the quick session menu:

```text
/codex s
/codex session
```

Use the buttons to create a new same-repo session thread, bind a recent session, unbind the current session, toggle send mode, or inspect status/recent sessions. This is the recommended desktop and mobile flow for day-to-day use.

Start a new Codex session:

```text
/codex new api analyze and fix the CI failure
!codex new --cwd web $review review the current diff
```

By default, executable Codex commands are queued as pending commands so you can inspect or edit them before running. Add `-f` or `--force` to execute immediately:

```text
/codex new -f api analyze and fix the CI failure
!codex send -f $test-fixer fix the failing tests first
```

Send to the current session:

```text
!codex send $test-fixer fix the failing tests first
```

If the current Codex turn is active, `send` calls `turn/steer`. If the session is idle, it starts a new turn on the same Codex thread.

In CLI mode, active-turn steering is not available because `codex exec` is non-interactive once the process is running. Wait for the turn to finish, then use `send` again. App-server mode can steer active turns.

Manage pending commands:

```text
!codex pending
!codex pending-edit 1 update this prompt before execution
!codex pending-drop 1
!codex pending-run 1
!codex pending-run all
```

Pending queues are scoped to the current Slack thread. Outside a thread, they are scoped to the channel.

Steer only an active turn:

```text
!codex steer focus on API tests, not UI work
```

Resume an existing Codex thread:

```text
/codex recent
/codex resume 2
/codex resume 2 continue with lint fixes
/codex resume thr_1234567890abcdef
/codex resume thr_1234567890abcdef continue with lint fixes
```

Bind the current channel or thread to a recent Codex session:

```text
/codex s
/codex bind-session
/codex bind-session 2
/codex bind-session 019f20cf
/codex unbind-session
```

Without an argument, `bind-session` shows a recent-session picker. `/codex s` exposes the same picker behind `Bind recent` and also includes `New session`, `Unbind`, and `Send mode on/off`. After binding, normal channel messages continue that Codex session only when send mode is on. `send`, `$skill ...`, and the configured prefix remain explicit controls.

Explore recent sessions:

```text
/codex recent
!codex sessions
```

The list includes Slack-created sessions and existing local Codex CLI sessions from `CODEX_SESSIONS_DIR`. Each entry starts with the workspace folder name, then shows the Codex session ID, status, working path, Slack thread when already bound, last prompt, and last response.

For local Codex CLI sessions, `active` means the JSONL log has an unfinished turn or a currently running local `codex` process references that session ID. This includes Codex sessions you opened directly in a terminal, even if they were not started through Slack.

Show only active CLI sessions and create a channel from one:

```text
/codex active
/codex active --channel repo-followup 1
```

View commands sent inside a session and rerun one exactly:

```text
!codex history
!codex history 2
!codex rerun-command 1
!codex rerun-command 1 2
!codex rerun-command -f 1 2
```

`history` reads Slack-recorded commands for Slack-created sessions and user prompts from local Codex CLI JSONL logs for terminal-created sessions. `rerun-command` queues by default; add `-f` to execute immediately.

Rerun the last stored prompt:

```text
!codex rerun
!codex rerun $review review the updated diff again
```

Rerun a specific recent session by list number, full ID, partial ID, or `last`:

```text
!codex rerun-session 2
!codex rerun-session 2 rerun this with more concise output
!codex rerun 2
!codex rerun 019f20dd
!codex rerun last $review review this session again
```

Check session status:

```text
!codex status
```

Interrupt the current session:

```text
!codex stop
```

## Security Defaults

- CLI mode spawns local `codex` processes; no Codex HTTP server is exposed.
- App-server mode uses `stdio://`; no Codex HTTP server is exposed.
- Slack operators are restricted by `ALLOWED_SLACK_USER_IDS` unless `ALLOW_ALL_SLACK_USERS=1`.
- Workspaces outside `baseDirs` are rejected.
- Server-initiated approval requests are declined by default.
- There is no shell passthrough command.
- `danger-full-access` is not used unless you explicitly set it in Codex defaults.

## Limitations

- CLI mode changes the actual `cwd` of the spawned Codex process and passes `-C <workspace>` to `codex exec`. It cannot change the parent shell or a visible Windows Terminal tab that launched the bridge.
- The Codex app-server protocol may change across Codex versions. If requests fail, inspect the installed protocol with your local Codex version.
- CLI mode cannot steer active turns; app-server mode can.
- Slack slash commands cannot run inside Slack threads. Use `@bot` or `!codex` inside a thread.
- Interactive Slack approval buttons are not implemented. The default server request handler declines requests.
- End-to-end Slack validation requires real Slack tokens and a workspace install.

## Development

```bash
npm run check
npm test
npm run build
```

## License

MIT.
