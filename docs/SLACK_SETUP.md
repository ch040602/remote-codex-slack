# Slack Setup Checklist

This bridge uses Slack Socket Mode. It receives Slack events locally over the app-level WebSocket connection, so no public callback URL is required.

## Create The App

1. Open <https://api.slack.com/apps>.
2. Create a new app from scratch.
3. Select the Slack workspace that will control Codex.
4. Enable **Socket Mode**.
5. Create an app-level token with `connections:write`.
6. Copy the `xapp-...` token to `.env` as `SLACK_APP_TOKEN`.

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
Usage hint: help | new | send | resume | recent | rerun | pwd
```

Slash commands are not available inside Slack threads. Use an app mention or the configured prefix, for example `!codex send ...`, inside threads.

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
```

```bash
npm run dev
```

Then in Slack:

```text
/codex projects
/codex bind-channel api
/codex new $example summarize this repository
```

To browse configured local skills before sending work:

```text
/codex $
/codex $exa
/codex skills example
```

Slack does not let bots display a live popup while you are typing `$` in the message composer. Send `$`, `$prefix`, or `skills <prefix>` as a message to get the list or filtered matches.

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

1. Keep the terminal running `npm run dev`.
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
