# Slack Setup Checklist

This bridge uses Slack Socket Mode. It receives Slack events locally over the app-level WebSocket connection, so no public callback URL is required.

## Create The App

1. Open <https://api.slack.com/apps>.
2. Create a new app from scratch.
3. Select the Slack workspace that will control Codex.
4. Enable **Socket Mode**.
5. Create an app-level token with `connections:write`.
6. Copy the `xapp-...` token to `.env` as `SLACK_APP_TOKEN`.

## Enable Interactivity

Open **Interactivity & Shortcuts** and enable interactivity. The bridge uses Block Kit action payloads for command and skill picker menus. With Socket Mode enabled, these action payloads are delivered to the local Bolt app over the app-level WebSocket connection.

## Configure Bot Permissions

Add these bot token scopes under **OAuth & Permissions**:

```text
app_mentions:read
chat:write
commands
channels:history
channels:join
channels:read
im:history
im:read
groups:history
groups:read
```

Optional scopes for `npm run channels:create`:

```text
channels:manage
groups:write
users:read
```

Install or reinstall the app after changing scopes, then copy the `xoxb-...` bot token to `.env` as `SLACK_BOT_TOKEN`.

## Add The Slash Command

Create a slash command:

```text
Command: /codex
Request URL: use any valid placeholder if Slack requires one; Socket Mode will deliver the command.
Short description: Control local Codex
Usage hint: s | send-mode on|off | send-policy immediate|confirm|pending | notify-mode final-only|answer-updates | ? | $ | pwd | ls | cd <path> | send <prompt>
```

Slash commands are not available inside Slack threads. In a linked thread, normal replies are sent to Codex while send mode is on. Plain bot commands such as `bind-session 2`, `recent`, `history 2`, and `pending` also work without a bang prefix.

After a channel is bound to a workspace/session, normal channel and thread messages are treated as `send <message>` while send mode is on. Workspace navigation messages that start with `cd`, `use`, `pwd`, `ls`, or `projects` stay local bot commands, so `cd src` changes the Slack-bound cwd instead of being forwarded to Codex. These workspace commands also work when send mode is off. Send mode defaults to on, and you can turn it off with `/codex send-mode off` or the `/codex s` button menu. The default send policy is `immediate`, including newly linked sessions, so the bridge behaves like a ChatGPT-style Slack chat by default. If Codex is already working on that session, additional normal messages or `send` input are queued as pending commands instead of interrupting the active turn. The default notify mode is `final-only`, so Slack channel notifications are posted only when a final answer is available. Use `notify-mode answer-updates` only when you also want in-progress answer updates from externally running CLI sessions. Use `send-policy confirm` for Run now / Keep queued / Cancel buttons, or `send-policy pending` to queue all runnable input. Messages that start with `/` are reserved for Slack slash commands and are not forwarded to Codex by the message listener.

For the simplest session workflow, use:

```text
/codex s
```

This opens buttons for `New session`, `Bind recent`, `Unbind`, `Send mode on/off`, `Immediate`, `Confirm`, `Pending`, `Final only`, `Answer updates`, `Status`, and `Recent`. On desktop, type `/codex s` and click the button. On mobile, send `/codex s` and tap the button or picker in the bot response.

In a newly created public Slack channel, you can run `/codex s`, `/codex cd <path>`, `/codex bind-session`, or `/codex new ...` directly in that channel. If the bot is not already a member, the bridge uses `channels:join` to join before posting the session thread, so the current channel becomes the linked Codex channel. For private channels, invite the app to the channel first.

## Connect Channels To Projects

Use one of these options:

1. Manually invite the bot to existing channels and add channel IDs to `config/projects.yaml`.
2. Add projects with local paths and run `npm run channels:create`. Channel names are derived from the project folder basename.
3. Bind a channel from Slack with `/codex use --channel <project>`.

Example:

```yaml
projects:
  api:
    path: "api-server"
    default: true

channelBindings:
  C0123456789: api
```

This creates or reuses `#api-server` because the local working folder is `api-server`. If `#api-server` already exists, the script asks whether to merge into it or create `#api-server-2`.

## Start The Bridge

Use CLI mode unless you explicitly need the experimental app-server driver:

```env
CODEX_DRIVER=cli
CODEX_BIN=codex
CODEX_SESSIONS_DIR=%USERPROFILE%/.codex/sessions
```

```bash
npm start
```

Then in Slack:

```text
/codex projects
/codex use --channel api
/codex s
/codex new $example summarize this repository
```

For quick navigation in a normal channel message, `projects`, `pwd`, `ls`, and `cd <path>` can be sent without `/codex`.

To browse configured local skills before sending work:

```text
/codex $
/codex $exa
/codex $example summarize this repository
$example summarize this repository
/codex skills example
```

Slack does not let bots display a live popup while you are typing `$` in the message composer. Send `$`, `$prefix`, or a prompt containing unfinished `$` / `$prefix` to open a skill picker. Choosing a skill replaces that token in the original command and continues the normal queue/run flow. When send mode is on, a channel message that starts with `$skill` is treated as a Codex skill prompt without writing `send`; when send mode is off, use `/codex send ...` in a channel or an app mention.

To browse command suggestions or recover from a partial command:

```text
/codex ?
/codex commands pend
/codex pend
commands statu
```

Suggestion text follows the current `language en|ko` setting. The response includes an interactive command menu: commands without required arguments run immediately, while commands that need arguments show focused usage help.

Skill picker examples:

```text
/codex new inspect this repo with $
/codex new inspect this repo with $exa
fix tests with $exa
```

Normal bound-channel messages also participate in this flow while send mode is on. Sending `/codex pwd` runs a bot command instead of forwarding `/codex pwd` to Codex.

You can also create a project channel directly from Slack:

```text
/codex api-work
```

The new channel starts at `CODEX_NAV_ROOT` (Desktop by default). Use:

```text
/codex pwd
/codex ls
/codex cd my-project
```

Then queue or run Codex work. The selected cwd is fixed to that channel/session when the real command is submitted.

To fork a recent session into another channel:

```text
/codex recent --channel api-followup 1
```

To resume a session from the recent list by number:

```text
/codex recent
/codex resume 2
/codex resume 2 continue with lint fixes
```

To bind the current channel or thread to a recent session:

```text
/codex s
/codex bind-session
/codex bind-session 2
/codex unbind-session
```

Without an argument, `bind-session` shows a picker. `/codex s` gives the same picker behind the `Bind recent` button and also provides `New session`, `Unbind`, and `Send mode on/off`. After binding, the session starts in `immediate` mode. Normal channel and thread messages continue that Codex session when send mode is on. `send`, `$skill ...`, and plain bot commands remain explicit controls.

`recent` includes sessions started through this Slack bridge and existing local Codex CLI sessions found under `CODEX_SESSIONS_DIR`.

For local Codex CLI sessions, `active` means the JSONL log has an unfinished turn or a currently running local `codex` process references that session ID. This also covers sessions you opened directly in a terminal.

After you bind a local CLI session to a Slack channel or thread, the bridge polls `CODEX_SESSIONS_DIR` and posts a Slack message whenever that terminal-run session writes a new assistant answer. This still works when the terminal Codex process remains open and the session appears `active`. Slack-started turns already post their completion event directly.

To create or link a channel from a currently running CLI session:

```text
/codex active
/codex active --channel api-followup 1
```

To view commands from a session and rerun one exactly:

```text
history
history 2
rerun-command 1
rerun-command 1 2
rerun-command -f 1 2
```

`rerun-command` follows the current `send-policy`; add `-f` to execute immediately. Use `rerun` with no arguments to open a preview picker. After choosing a session, use `Full preview` to see the complete prompt and last response before running or queueing it.

Command explanations are English by default. To switch a channel or thread to Korean:

```text
/codex language ko
```

Codex execution commands use `send-policy immediate` by default, including newly linked sessions. The start message shows buttons to switch modes per channel or thread:

```text
/codex send-policy immediate
/codex send-policy confirm
/codex send-policy pending
/codex notify-mode final-only
/codex notify-mode answer-updates
```

Use pending commands to review/edit queued work before execution:

```text
/codex pending
/codex pending-edit 1 summarize this repository and list risks
/codex pending-run 1
```

Use `-f` when you want immediate execution:

```text
/codex new -f $example summarize this repository
```

If `/codex` works but thread replies do not, invite the bot to the channel and use a plain linked-thread reply or `@YourBot` inside the target thread.

In CLI mode each Codex turn is a local child process started in the selected workspace, equivalent to:

```text
codex exec --json --skip-git-repo-check -C <workspace> -
```

## Use From PC

1. Keep the PC bridge running with `npm start`.
2. Open Slack desktop or Slack web.
3. Bind the project channel:

```text
/codex use --channel api
```

4. Browse skills when needed:

```text
/codex $
/codex $exa
```

5. Start a task:

```text
/codex new $example summarize this repository
```

6. Continue in the Slack thread:

```text
make the first safe improvement
```

## Use From Mobile

1. Leave the PC bridge process running.
2. Open the Slack mobile app.
3. Use `/codex pwd` in the project channel to confirm the workspace.
4. Send `/codex $` or `/codex $prefix` to browse configured skills.
5. Use `/codex new ...` in the channel to start a task.
6. Send a normal reply inside the linked thread for follow-up instructions.
7. Use `recent` to see recent sessions with working path and last response.
8. Use `rerun-session 1` to rerun a recent session.

Slash commands work from mobile channels, but not inside Slack threads. In linked threads, use normal replies for Codex input and plain bot commands such as `recent`, `history 2`, or `pending`.
