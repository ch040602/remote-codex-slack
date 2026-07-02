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
channels:read
im:history
im:read
groups:history
groups:read
```

Optional scopes for `npm run channels:create`:

```text
channels:manage
channels:join
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
Usage hint: s | send-mode on|off | ? | $ | pwd | ls | cd <path> | new [-f] <prompt> | send [-f] <prompt> | recent
```

Slash commands are not available inside Slack threads. Use an app mention or the configured prefix, for example `!codex send ...`, inside threads.

After a channel is bound to a workspace/session, normal channel messages are treated as `send <message>` only while send mode is on. Send mode defaults to on for backward compatibility, and you can turn it off with `/codex send-mode off` or the `/codex s` button menu. Messages that start with `/` are reserved for Slack slash commands and are not forwarded to Codex by the message listener.

For the simplest session workflow, use:

```text
/codex s
```

This opens buttons for `New session`, `Bind recent`, `Unbind`, `Send mode on/off`, `Status`, and `Recent`. On desktop, type `/codex s` and click the button. On mobile, send `/codex s` and tap the button or picker in the bot response.

## Connect Channels To Projects

Use one of these options:

1. Manually invite the bot to existing channels and add channel IDs to `config/projects.yaml`.
2. Add projects with local paths and run `npm run channels:create`. Channel names are derived from the project folder basename.
3. Bind a channel from Slack with `/codex bind-channel <project>` or `/codex use --channel <project>`.

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
/codex bind-channel api
/codex s
/codex new $example summarize this repository
```

To browse configured local skills before sending work:

```text
/codex $
/codex $exa
/codex $example summarize this repository
$example summarize this repository
/codex skills example
```

Slack does not let bots display a live popup while you are typing `$` in the message composer. Send `$`, `$prefix`, or a prompt containing unfinished `$` / `$prefix` to open a skill picker. Choosing a skill replaces that token in the original command and continues the normal queue/run flow. When send mode is on, a channel message that starts with `$skill` is treated as a Codex skill prompt even without `!codex send`; when send mode is off, use `/codex send ...`, `!codex send ...`, or an app mention.

To browse command suggestions or recover from a partial command:

```text
/codex ?
/codex commands pend
/codex pend
!codex statu
```

Suggestion text follows the current `language en|ko` setting. The response includes an interactive command menu: commands without required arguments run immediately, while commands that need arguments show focused usage help.

Skill picker examples:

```text
/codex new inspect this repo with $
/codex new inspect this repo with $exa
!codex send fix tests with $
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

Without an argument, `bind-session` shows a picker. `/codex s` gives the same picker behind the `Bind recent` button and also provides `New session`, `Unbind`, and `Send mode on/off`. After binding, normal channel messages continue that Codex session only when send mode is on. `send`, `$skill ...`, or prefixed messages remain explicit controls.

`recent` includes sessions started through this Slack bridge and existing local Codex CLI sessions found under `CODEX_SESSIONS_DIR`.

For local Codex CLI sessions, `active` means the JSONL log has an unfinished turn or a currently running local `codex` process references that session ID. This also covers sessions you opened directly in a terminal.

To create or link a channel from a currently running CLI session:

```text
/codex active
/codex active --channel api-followup 1
```

To view commands from a session and rerun one exactly:

```text
!codex history
!codex history 2
!codex rerun-command 1
!codex rerun-command 1 2
```

Command explanations are English by default. To switch a channel or thread to Korean:

```text
/codex language ko
```

Codex execution commands are queued by default. Use pending commands to review/edit before execution:

```text
/codex pending
/codex pending-edit 1 summarize this repository and list risks
/codex pending-run 1
```

Use `-f` when you want immediate execution:

```text
/codex new -f $example summarize this repository
```

If `/codex` works but thread replies do not, invite the bot to the channel and use `!codex` or `@YourBot` inside the target thread.

In CLI mode each Codex turn is a local child process started in the selected workspace, equivalent to:

```text
codex exec --json --skip-git-repo-check -C <workspace> -
```

## Use From PC

1. Keep the PC bridge running with `npm start`.
2. Open Slack desktop or Slack web.
3. Bind the project channel:

```text
/codex bind-channel api
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
!codex send make the first safe improvement
```

## Use From Mobile

1. Leave the PC bridge process running.
2. Open the Slack mobile app.
3. Use `/codex pwd` in the project channel to confirm the workspace.
4. Send `/codex $` or `/codex $prefix` to browse configured skills.
5. Use `/codex new ...` in the channel to start a task.
6. Use `!codex send ...` inside the thread for follow-up instructions.
7. Use `!codex recent` to see recent sessions with working path and last response.
8. Use `!codex rerun-session 1` to rerun a recent session.

Slash commands work from mobile channels, but not inside Slack threads. In threads, use the configured prefix, for example `!codex`.
