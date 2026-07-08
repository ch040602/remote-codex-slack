# Codex Slack Workspace Bridge

Self-hosted Slack bridge for controlling local Codex CLI workspaces and sessions from Slack.

This is not OpenAI's hosted Codex Slack app. It runs on your PC, listens to Slack through Socket Mode, and starts the local `codex` CLI in the workspace you selected from Slack.

## What It Does

- Browse local workspaces from Slack with `pwd`, `ls`, and `cd`.
- Create or reuse Slack channels for workspaces.
- Bind one Slack channel or thread to one Codex session.
- Start, resume, rerun, and inspect Codex sessions.
- Show recent Slack-created sessions and existing local Codex CLI sessions.
- Mark currently running local CLI sessions as `active`.
- Post Codex working messages in Slack threads and broadcast final/new assistant answers to the channel.
- Use configured local Codex skills with `$skill-name`.
- Choose send behavior: `immediate`, `confirm`, or `pending`.
- Run in the background on Windows with logs in `data/bridge.log`.

## Architecture

```text
Slack desktop/mobile
  |-- /codex slash command
  |-- @bot mention
  |-- plain bot commands such as bind-session, recent, history, pending
  `-- normal channel message when send mode is on
        |
        v
Local bridge process
  |-- Slack Socket Mode
  |-- workspace/session state
  |-- command and skill pickers
  `-- local Codex CLI runner
        |
        v
codex exec -C <workspace> ...
```

## Requirements

- Node.js 20 or newer.
- Codex CLI installed locally and logged in.
- A Slack workspace where you can install apps.
- A Slack app with Socket Mode enabled.
- A bot token and app-level token.

Check Codex locally first:

```bash
codex exec --skip-git-repo-check "reply with exactly OK"
```

## Install

```bash
git clone https://github.com/ch040602/remote-codex-slack.git
cd remote-codex-slack
npm install
cp .env.example .env
cp config/projects.example.yaml config/projects.yaml
cp config/skills.example.yaml config/skills.yaml
```

Windows PowerShell:

```powershell
git clone https://github.com/ch040602/remote-codex-slack.git
cd remote-codex-slack
copy .env.example .env
copy config\projects.example.yaml config\projects.yaml
copy config\skills.example.yaml config\skills.yaml
npm install
```

`.env` is ignored by git. Do not commit Slack tokens.

## Slack App Setup

Use Socket Mode. You do not need ngrok or a public HTTP endpoint.

1. Open <https://api.slack.com/apps> and create an app in the target workspace.
2. Open **Socket Mode** and enable it.
3. Create an app-level token with `connections:write`.
4. Put it in `.env` as `SLACK_APP_TOKEN=xapp-...`.
5. Open **Interactivity & Shortcuts** and enable interactivity.
6. Open **OAuth & Permissions** and add bot scopes.
7. Install or reinstall the app to the workspace.
8. Put the bot token in `.env` as `SLACK_BOT_TOKEN=xoxb-...`.
9. Add your Slack user ID to `ALLOWED_SLACK_USER_IDS`.
10. Create the slash command `/codex`.
11. Start the bridge with `npm start`.

Recommended bot scopes:

```text
app_mentions:read
chat:write
commands
channels:history
channels:join
channels:read
groups:history
groups:read
im:history
im:read
```

Add these only if you want the bridge to create channels and invite users:

```text
channels:manage
groups:write
users:read
```

Slash command settings:

```text
Command: /codex
Request URL: any valid placeholder URL if Slack requires one
Short description: Control local Codex
Usage hint: s | bind-session | recent | send-policy immediate|confirm|pending | ? | $ | pwd | ls | cd <path> | send <prompt>
```

Socket Mode delivers slash commands to the local bridge. Slack still asks for a Request URL in some screens, but it is not used as the runtime transport.

## Environment

Edit `.env`:

```env
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
ALLOWED_SLACK_USER_IDS=U0123456789
# Optional legacy message prefix. Leave empty when you use /codex, @bot, and plain commands.
SLACK_COMMAND_PREFIX=

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

Use `ALLOW_ALL_SLACK_USERS=1` only in a private test workspace.

## Project Configuration

Edit `config/projects.yaml`:

```yaml
baseDirs:
  - "C:/Users/me/work"
  - "/home/me/work"

defaults:
  sandbox: "workspaceWrite"
  approvalPolicy: "never"

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
- Absolute paths are allowed only inside one of the configured `baseDirs`.
- If `baseDirs` is empty, any local path is accepted. Use this only for trusted personal setups.
- `channelBindings` maps Slack channel IDs to project names.
- Project channels use the workspace folder basename by default.
- If a channel name already exists, the channel creation flow asks whether to reuse it or create a suffixed name such as `repo-2`.

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

Use skills from Slack:

```text
/codex $
/codex $rev
$review inspect this repo
$test-fixer fix failing tests
```

Slack bots cannot display a live popup while you are still typing in the normal message composer. Instead, send `$`, `$prefix`, or a prompt containing unfinished `$` / `$prefix`; the bridge replies with a Slack picker. Choosing a skill replaces the token and continues the normal send flow.

## Running

Default background mode:

```bash
npm start
```

Windows background controls:

```powershell
npm run win:bg:start
npm run win:bg:status
npm run win:bg:stop
```

Foreground development mode:

```bash
npm run dev
```

Build and run compiled output:

```bash
npm run build
npm run start:fg
```

Background mode writes logs to `data/bridge.log`. It does not create a tray icon. Use `npm run win:bg:status` or `/codex pwd` in Slack to confirm that the bridge is running.

Keep the PC on while using Slack from mobile. Slack messages reach this local process through Socket Mode, and this local process starts `codex`.

## First Use

The Slack workspace must already exist. The bridge can create channels.

Create or open a workspace channel:

```text
/codex remote-codex-slack
```

Browse from the navigation root:

```text
/codex pwd
/codex ls
/codex cd remote-codex-slack
/codex pwd
```

Open the quick session menu:

```text
/codex s
```

Use the buttons:

- `New session`: create a new Codex session thread for the current cwd.
- `Bind recent`: choose a recent Slack or local CLI Codex session.
- `Unbind`: remove the session binding.
- `Send mode on/off`: decide whether normal chat becomes Codex input.
- `Immediate`, `Confirm`, `Pending`: choose how runnable input is handled.
- `Status`, `Recent`: inspect current and recent sessions.

Newly linked sessions default to `immediate`, so normal messages in the linked thread are sent to Codex without writing `send`. If Codex is already working on that session, additional `send` input or normal messages are queued as pending commands instead of trying to interrupt the active turn. Workspace navigation messages that start with `cd`, `use`, `pwd`, `ls`, or `projects` stay local bot commands, so `cd src` changes the Slack-bound cwd instead of being forwarded to Codex.

The bot posts a working message in the thread when a turn starts. Final answers and newly detected local CLI assistant answers are posted as thread replies with Slack `reply_broadcast`, so the answer also appears in the channel instead of being hidden only inside the thread.

## Desktop Workflow

1. Start the bridge on the PC:

```bash
npm start
```

2. Open Slack desktop or Slack web.
3. Go to the project channel.
4. Check the workspace:

```text
/codex pwd
```

5. Bind or create a session:

```text
/codex s
```

6. Start work:

```text
/codex new inspect this repository and run the relevant tests
```

7. Continue in the created thread:

```text
implement the first fix
```

## Mobile Workflow

1. Leave the PC on with the bridge running.
2. Open Slack mobile.
3. Go to the project channel.
4. Check the workspace:

```text
/codex pwd
```

5. Open the quick session menu:

```text
/codex s
```

6. Tap `New session` or `Bind recent`.
7. Open the created or bound thread.
8. Send a normal thread reply to continue the Codex session:

```text
focus on the smallest safe change
```

## Commands

Help and suggestions:

```text
/codex help
/codex ?
/codex commands pend
/codex language ko
/codex language en
```

Workspace:

```text
pwd
ls
cd <project-or-path>
projects
```

The explicit slash command form remains available everywhere slash commands work:

```text
/codex pwd
/codex ls
/codex cd <project-or-path>
/codex projects
```

Session:

```text
/codex s
/codex new <prompt>
/codex send <prompt>
/codex bind-session
/codex bind-session 2
/codex bind-session <session-id-prefix>
/codex unbind-session
/codex recent
/codex active
/codex status
```

Pending and send policy:

```text
/codex send-policy immediate
/codex send-policy confirm
/codex send-policy pending
/codex pending
/codex pending-edit 1 <new prompt>
/codex pending-run 1
/codex pending-run all
/codex pending-drop 1
```

Rerun:

```text
/codex history
/codex rerun
/codex rerun-session 2
/codex rerun-command 1
/codex rerun-command -f 1
```

Add `-f` or `--force` to execution commands when you want to bypass queueing and run immediately.

## Local CLI Sessions

`recent` includes:

- Sessions created through this Slack bridge.
- Existing local Codex CLI sessions under `CODEX_SESSIONS_DIR`.

Each entry shows:

- Workspace folder name first.
- Full cwd.
- Codex session ID.
- Status.
- Last prompt.
- Last response.

`active` means the Codex JSONL log has an unfinished turn or a currently running local `codex` process references the session ID. This works even for sessions started directly from a terminal instead of Slack.

After a local CLI session is bound to a Slack channel or thread, the bridge polls `CODEX_SESSIONS_DIR` and posts a Slack message whenever that external CLI session writes a new assistant answer. This still works when the terminal Codex process remains open and the session appears `active`. Slack-managed turns use their normal completion event, so the poller skips active turns started by the bridge to avoid duplicate messages.

Those answer messages are broadcast to the channel from the linked thread. Long answers may continue in additional thread-only chunks after the broadcasted first message.

## Channel Creation

Create a channel directly from Slack:

```text
/codex <channel-name>
```

The channel starts at `CODEX_NAV_ROOT`, which defaults to your Desktop. Use `pwd`, `ls`, and `cd` to move to a workspace. The first real Codex command fixes the workspace/session for that channel.

Create channels from `config/projects.yaml`:

```bash
npm run channels:create
```

The script creates or reuses channels, asks what to do on name conflicts, invites configured users, and stores bindings in `data/state.json`.

## Bind Session Reliability

`/codex bind-session` with no argument opens a recent-session picker. The picker is built to stay inside Slack Block Kit limits:

- Section text is capped below Slack's 3000 character limit.
- Empty text fields are replaced with safe placeholders.
- Select option labels and descriptions are truncated to valid lengths.
- Slash command fallback uses ephemeral responses and avoids reposting invalid blocks as public channel messages.

If you still see an error:

1. Run `npm run win:bg:status`.
2. Check `data/bridge.log`.
3. In Slack, run a fresh `/codex bind-session`; do not reuse an old picker message after a restart.
4. For private channels, invite the app to the channel first.
5. For public channels, make sure the app has `channels:join`.

## Security Defaults

- CLI mode starts local `codex` processes; no Codex HTTP server is exposed.
- App-server mode uses `stdio://`; no Codex HTTP server is exposed.
- Operators are restricted by `ALLOWED_SLACK_USER_IDS` unless `ALLOW_ALL_SLACK_USERS=1`.
- Workspaces outside configured `baseDirs` are rejected.
- There is no shell passthrough command.
- `.env` and `data/*.json` are ignored by git.

## Limitations

- Slack slash commands do not run inside Slack threads. Use normal linked-thread replies for Codex input, plain bot commands such as `recent` or `history 2`, or `@bot` mentions.
- CLI mode cannot steer an already running `codex exec` process. Wait for the turn to finish, then send again.
- True live autocomplete while typing `$` in a normal Slack message is not available to Slack bot apps; the bridge uses message-based pickers.
- End-to-end Slack validation requires real Slack tokens and a workspace install.

## Development

```bash
npm run check
npm test
npm run build
```

## License

MIT
