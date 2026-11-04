# The DO (Distributed AI Orchestrator)

**Your projects, across your machines and models—with development history you keep.**

The DO brings the computers on your private network into one development workspace.
Run project sessions on different machines, switch models within a conversation,
and work from your laptop or phone. Combine API models, coding subscriptions, and
models running on your own GPUs. The DO keeps saved conversations and distributed
session state on your computers so you can return to the work with its context.

## Put your network to work

- **Projects across machines.** Choose which computers hold each project and
  where its tabs run. Use your laptop for one session and a powerful desktop for
  another, from the same interface. The DO has no configured host-count limit;
  practical capacity depends on your computers and network.
- **Models you can mix and swap.** Bring API keys, signed-in coding CLI
  subscriptions, or local models through Ollama and compatible model servers.
  Use a GPU machine as a model host. Switch models mid-conversation with the
  saved history, or give different tabs different models to develop and review
  the same project. Each execution host exposes its own available sources.
- **Distributed state with clear ownership.** The DO persists and synchronizes
  session history, project records, and shared configuration between approved
  hosts. Returning hosts catch up from replicated history and snapshots. Project
  Git copies follow published changes; unfinished tab files stay on their owner.
- **A development history you control.** Conversations, tool results, and project
  context stay in The DO’s local storage on your hosts. Resume a saved session
  without starting the explanation over. API and subscription requests still go
  to the provider you choose; local model hosting is an alternative.

The DO supports one computer or a growing network. With three or more hosts,
shared writes require a majority. Two hosts prioritize availability and can
produce conflicting histories during a split; those branches are archived for
explicit recovery. There is no promise of unlimited scale or automatic merging
of every offline edit. See [how distributed state works](docs/machines.md).

## Ask The DO about what happened

The DO records **local diagnostic traces** of meaningful actions, navigation,
visible screen states, requests, timings, and failures. Correlation IDs connect
browser actions to server work. In a DO session, you can ask:

> “Check the recent traces from my machines and explain why that project did
> not open, then fix the cause.”

Sessions can inspect the authenticated diagnostics APIs across reachable hosts.
Traces stay on the computer that recorded them and are combined on demand;
an offline host means missing evidence. They are bounded and rotated, and omit
message content, keystrokes, credentials, and screenshots. Manage recording and
retention in **Settings → Usage history · diagnostics**. Saved conversations
are separate from these diagnostic logs.

The DO also instructs coding sessions to add useful, private, bounded tracing to
the apps they build, so a later session can investigate a reported problem.
See [trace locations and how sessions read them](docs/development.md).

All screenshots below show the real interface with **fictional demo conversations,
projects, and devices**. No personal chat history is included.

![A coding chat and successful Push in The DO](docs/images/chat-desktop.png)

## Build an app, then use it

Ask The DO to build an app with a frontend that works well on **both phone and
computer**—readable layouts, touch-friendly controls, and roomier desktop views.
These are responsive browser apps, not automatically compiled native iOS,
Android, macOS, or Windows applications.

> “Build a garden planner for my phone and computer. Register its start command
> with The DO, launch it, and give me the links.”

Once the project has a saved start command, The DO recognizes it as a launchable
app in **Projects & sessions** (☰). Use **▶** to start it and **■** to stop its server, from
The DO on a phone or computer connected to its owning host. Closing an app's
browser tab leaves its server running. The host must stay awake; controls from
another host currently require using the process-owning host.

Running, reachable apps offer a **phone / away-from-home address** through
Tailscale and a **local laptop address** for the hosting computer. Those are
connection choices. The separate **Phone layout** and **Desktop layout** links
preview the app at a fixed viewport on either device: inspect the desktop layout
from your phone, or the phone layout from your computer. Switch sizes within the
preview without reopening the app.

Previews use the real app and its data, so actions have real effects. They scale
390 × 844 or 1280 × 900 viewports to fit; they do not emulate another operating
system, touch hardware, or browser. Apps that block embedding must be opened
directly. Remote previews need the app's working Tailscale address.

Don't like the app, the layout, or how The DO works? Tell a session what to
change. For changes to The DO itself, use its built-in project: the change runs on
that computer as soon as the turn ends, so you can try it right away. **Push** it
when you like it.

## Choose how a session works

**Pause** stops a running turn straight away and holds any queued messages.
For project work it also saves a short checkpoint file in the tab's folder
(`.harness-resume/`, which Git ignores): what was asked, the steps that ran,
the files changed so far. The pause survives a restart, so **Resume** is still
there afterwards; it asks the agent to re-read the checkpoint and carry on,
then runs the queued messages. Tap **checkpoint** on the paused bar to read it.

In **Edit session**, choose the model and reasoning effort. The header shows the
configured effort; “provider default” means DO has not overridden it. Unsupported
levels report an error rather than silently reducing reasoning.

Each message you send then shows the model and effort it went to, exactly as the
provider reported them: for example `Claude Code: claude-opus-5-5 · max`. DO never
fills these in from its settings. If the provider does not say, the header says
`effort not reported`, and if it differs from what you chose it turns yellow and
shows both. Tap it to see which provider record each value came from.

Claude sessions use the Claude Code Agent SDK with native tools and local session
resume. They run the Claude Code you installed (`claude` on your PATH), so the
version, models and login match your terminal; without one, the copy bundled with
the SDK runs. Pushing a tab does not restart Claude's session. Questions and
permission requests appear above the composer; answer,
allow once, decline, or Stop. Claude permission modes are also available in Edit
session, including plan-only and explicitly selected full host access. Native
history stays on its execution computer; DO's portable transcript remains saved
across the network.

Codex currently uses `exec`, while API sources use DO's tools. Their capabilities
are described in Edit session: the Codex adapter does **not yet** relay native
interactive approvals or resume native threads. These are not interchangeable
copies of the full terminal applications.

Project records remain visible when their owner is offline. The list identifies
where the files live; saved chats can still be opened, while execution requires
the owning computer. Project metadata and transcripts are not a backup of
uncommitted files on that computer.

## What you need

On each computer:

- **Node.js 22 or newer** and **Git**.
- **Tailscale**, installed and connected to your private network.
- An **AI source**: a signed-in coding CLI, an API key, or a local model through Ollama.
- **GitHub CLI** if you want to connect GitHub and push changes.

Mac, Windows and Linux are supported; Windows does not need WSL. Your computer runs the
work, so keep it awake with The DO running when you use your phone.

## Start your first computer

1. **Fork this repository on GitHub** into your own account.
2. Clone **your fork**. Replace `YOUR-USERNAME` below with your GitHub username:

   ```sh
   git clone https://github.com/YOUR-USERNAME/Distributed-AI-Orchestrator.git
   cd Distributed-AI-Orchestrator
   ```

3. Double-click **Start DO** in that folder. On Linux, run **Start DO.sh** once, and after
   that The DO is in your apps menu. On a Mac, drag it to the Dock to keep it one click away.

   No terminal appears. The first start installs dependencies, then The DO opens in your browser.
   A small window shows whether it is online and which computers and viewers are connected.
   **Closing that window stops The DO on this computer.** Other computers keep running.
4. In **Settings → AI sources**, add the model you want to use.
5. Open **☰ → new project**, then start a session and describe what you want.

On that computer, The DO is at **http://127.0.0.1:8787**.
To publish, connect your account under **Settings → GitHub connection**.
AI subscriptions and API keys are separate options; install and sign in to a
subscription CLI on the computer that will run it.

![Projects and their sessions](docs/images/projects.png)

![Settings for GitHub, AI sources, phones, and computers](docs/images/settings.png)

## Add your phone

1. Install Tailscale on your phone and join the **same Tailscale network**.
2. On your computer, open **Settings → Phone access · Tailscale**.
3. Choose **set up phone access** and approve HTTPS in Tailscale if asked.
4. Open the displayed **Phone / away from home** address on your phone.
   Bookmark it or add it to your home screen.

The phone uses a browser; it does not need Node, Git, or an AI installation.
Use the displayed phone address, not `127.0.0.1`—that address only works on the host.

![Phone access setup with example addresses](docs/images/phone-setup.png)

<img src="docs/images/chat-phone.png" alt="The same fictional project on a phone-sized screen" width="390">

## Add more computers

1. Install the requirements and clone **the same fork** on the new computer.
2. Start The DO there and connect Tailscale to the same network.
3. Enable **Phone access** on the first computer if you have not already.
4. On the new computer, open **Settings → Machines** and select **request to join**
   beside your existing main computer.
5. On the existing main, open **Machines**, refresh, and select **Approve host**.

Only approve computers you trust: paired hosts share sessions and API credentials.
Set up AI sources and subscription logins on each computer that will run them.
Project machine settings choose where copies live; unfinished tab work stays on
its owning computer. See [the machine guide](docs/machines.md) for details.

![Connected computers and a phone viewer](docs/images/machines.png)

## Make The DO your own

The DO can improve itself: open the built-in **Distributed Orchestrator** project
(the current in-app label) and start a session.
Ask for a change just as you would in any other project. Each coding tab works in
its own isolated copy. When a turn finishes, its changes run on that computer, with
no Push and no restart button: the page reloads, or The DO restarts itself once
nothing is running. They stay after a restart, and other computers only see that
they exist. The version in the header shows it: `Laptop · v1.03 + 3 unpushed files`.

- **Keep them:** press **Push** to merge, run the checks, publish, and number the
  release. Other computers pick it up automatically.
- **Drop them:** press **Push**, then **Discard changes**.
- **Stop running them but keep them in the tab:** tap the version in the header,
  then **back to published**.

If a change stops The DO from starting, that computer goes back to the published
version by itself and the tab says what went wrong.

![Customizing The DO in a dedicated session](docs/images/self-edit.png)

**Your fork is the destination only if you cloned your fork.** Connecting GitHub
signs you in; it does not create a fork or change the repository’s destination.
Check it from the repository folder for your copy of The DO:

```sh
git remote -v
```

The `origin` fetch and push addresses should name **your account and your fork**,
not the original repository. If you cloned the original by mistake,
start with a fresh clone of your fork before making changes. Without permission,
GitHub rejects a push to someone else’s repository; it does not redirect it to yours.

With that setup, your sessions in The DO push to **your repository**, not the author’s.
Use that same fork on every paired computer. Changes to your fork do not
contribute back to the original repository unless you separately open a pull request.

---

[Development, tests, and diagnostics](docs/development.md) ·
[Machine setup and troubleshooting](docs/machines.md)
