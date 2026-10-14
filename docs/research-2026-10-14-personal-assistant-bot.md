# Personal assistant "Bot" research: dots, Grok Bot, voice, channels, frameworks, plan (2026-10-14)

*Researched 2026-10-14 by a research subagent. Product names, dates and prices below are as reported by the sources linked; I did not re-verify them myself. Many openai.com pages returned 403 to the researcher, so the OpenAI "dots" details come from secondary coverage.*


Both names resolve to real products launched in the last two months:

- **"Dot by ChatGPT" is OpenAI's dots.** OpenAI announced them at DevDay on 29 Sep 2026. They are always-on agents inside ChatGPT.
- **"Grok Bot" is xAI's Grok Bot.** It has been in beta since 11 Aug 2026.
- **New Computer's Dot is a different product and no longer exists.** It shut down on 5 Oct 2025.

Grok companions and OpenAI's io hardware are related products, not what the user meant.

On sourcing: every openai.com page returned 403 to me. All dots details therefore come from secondary coverage of OpenAI's announcement. I list the openai.com URLs where those articles cite them, but none of the dots text is quoted from OpenAI directly.

---

## 1. What the existing products do

### Name resolution
- **OpenAI dots.** OpenAI's X post says "Introducing dots, powered by GPT-6 Astra. Remarkably capable, always-on agents built to handle everything." https://x.com/OpenAI/status/2104984504133918973
  - Some outlets wrote "GPT-6.1 Sol" or "6.1 Astra". OpenAI's own post says GPT-6 Astra. NBC reports that GPT-6.1 Astra was held back for safety reasons. https://www.nbcnews.com/tech/tech-news/openai-launches-dots-ai-agents-safety-questions-rcna600338
  - The announcement pages, as cited by secondary coverage: https://openai.com/index/introducing-dots/ and https://openai.com/index/how-we-build-safety-security-and-privacy-into-dots/ (both 403 for me).
- **xAI Grok Bot.** The x.ai news page is dated "Aug 11, 2026" and says "Grok Bot is your team of always-on agents." https://x.ai/news/introducing-grok-bot
- **New Computer's Dot.** It shut down on 5 Oct 2025. https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down/
- **Grok companions (Ani, Rudi, Valentine).** These are 3D voice companion characters from mid-2025, not assistants. https://tomsguide.com/ai/i-tried-groks-new-companion-feature-and-ive-never-felt-so-uncomfortable
- **OpenAI/io device.** It has not shipped. A court filing says it "will not ship to customers before the end of February 2027". https://tomsguide.com/ai/openai-court-filings-just-revealed-new-details-on-ai-device-with-jony-ive
- **A comparable launch: Meta Muse.** Released 8 Sep 2026, US only. It works through an app or WhatsApp, runs in a per-user VM, and has a "Sentinel" component that approves or blocks web actions. Paid tiers are $20 and $100. https://thenextweb.com/news/meta-muse-personal-ai-agent-launch

### Comparison

| | OpenAI dots | xAI Grok Bot | ChatGPT Pulse / Tasks / Work | New Computer Dot (closed) |
|---|---|---|---|---|
| Model | Always-on agent with its own cloud computer and browser, connecting to more than 4,000 apps through plugins. It can run several projects in parallel, and you can watch its screen. | A team of named bots, each with a persistent cloud computer (browser, file system, terminal). Bots coordinate in group chats. | Pulse researches overnight and shows 5–10 cards each morning. Tasks are scheduled prompts. Work is the agent mode. | A companion that "grows with you", with a journal-like "Chronicles" feature. |
| Proactive vs reactive | Proactive. When idle it does **read-only** "proactive research". | Proactive through routines: a workflow you demonstrate becomes a skill it reruns on a schedule. | Pulse is proactive and deliberately finite ("that's it for today"). Tasks run on a schedule or on events from Gmail, Slack or GitHub. | Reactive chat. |
| Memory | "Learns your preferences" from feedback. It does not train on its own notes. | Each bot keeps its own "memory, files, browser sessions and preferences". The FAQ says to verify against the source rather than trust memory. | Pulse requires ChatGPT memory to be on. | Long-term memory. Reviewers say it forgot things. |
| Approvals | Custom Rules (allow, require approval, or block per action), auto-review of actions that touch accounts or share data, and the ability to pause or stop. Password changes stay with the user. | "Sensitive or consequential actions can stop for approval." It recommends narrow "Ask first" rules for sending, publishing, deleting, purchasing and changing production systems. CAPTCHAs and 2FA are handed to the user. | Work asks for approval on important actions. | n/a |
| Voice | Voice calls are available. Texting is "coming soon". | "Start voice chat" on desktop, iOS and Android, and bots can send voice memos. | Scheduled tasks cannot use voice. | No |
| Channels | ChatGPT, Slack, Teams. | Desktop and mobile apps only. Slack or Telegram are not mentioned. | ChatGPT apps. | iOS only. |
| Price and availability | Pro ($100–$500) and Business Premium. The first dot is included. Not available in the EEA, UK or Switzerland. **Unknown whether Indonesia is an eligible market.** | Beta. Included with SuperGrok and Cursor plans, with its own separate usage meter. | Task caps: 5 on Plus, 15 on Pro. Hourly at most on paid plans. | Defunct. |
| Complaints | During the live demo the voice froze and a dot answered slowly. Early posts on X mention slow speed and actions taken without approval (low-reliability source). | The weekly allowance runs out in about 3 days, and the bot used models the user did not choose. | Pulse sometimes shows irrelevant items. | Forgot things, made things up. |

Sources for the table:
- dots: https://9to5google.com/2026/09/29/openai-dots-agent/ · https://traictory.com/news/2026-09-30-openai-dots-agents · NBC above
- Grok Bot: https://docs.x.ai/grok-bot · https://docs.x.ai/grok-bot/faq · https://forum.cursor.com/t/grok-bot-ultra-users-how-do-you-make-the-weekly-allowance-last-mine-reached-99-in-three-days/171221 · https://forum.cursor.com/t/grok-bot-draining-cursor-credit-pool/169982
- Pulse: https://www.tomsguide.com/ai/chatgpt-pulse-is-here-now-ai-starts-the-chat-and-curates-your-feed
- Tasks: https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- Work: https://letsdatascience.com/news/openai-expands-chatgpt-with-work-agent-cfc416d8
- New Computer Dot reviews: https://justuseapp.com/en/app/6450016041/dot-living-history/reviews

Claims I could not verify:
- **"ChatGPT agent is no longer available, use ChatGPT Work."** This comes from a search snippet of https://help.openai.com/en/articles/11752874-chatgpt-agent. The page itself returned 403.
- **CBS says Business Premium is "$20/month".** That looks wrong next to Pro at $100–$500, so I don't trust it. https://www.cbsnews.com/news/sam-altman-openai-dots-chatgpt-agents-safety/
- **Grok Bot runs on "Grok 4.6".** This appears only in secondary blogs. xAI's docs don't name the model. https://www.tryfriday.ai/blog/grok-bot-launch

### What sets each one apart (assessment)
- **dots:** read-only background research, plus per-action rules (allow, require approval, block).
- **Grok Bot:** several named bots with separate memories, and routines you teach by demonstration.
- **Pulse:** a briefing that is deliberately finite.

Your Bot can copy all three without needing its own computer, because the gateway's sessions already do the work.

---

## 2. Design patterns for a "chief of staff" assistant, mapped to what the gateway already has

| Pattern | Source | Gateway feature that already covers it |
|---|---|---|
| Ambient agent: interrupt only for notify, question or review, and keep an inbox of open items | https://blog.langchain.com/introducing-ambient-agents | Notice tiers (urgent, normal, quiet), ASK question cards, the bell |
| "Tell me only when it matters" | Horvitz's mixed-initiative principles (weigh the cost of an interruption against its value): https://www.erichorvitz.com/chi99horvitz.pdf | `noticeFor` tiers, presence suppression, quiet hours |
| Finite daily briefing | Pulse (above) | `schedule_task` plus a digest built from `get_activity`, `list_conversations` and `read_conversation` |
| Background monitoring is read-only; write actions need rules or approval | dots via traictory (above); Grok Bot FAQ "Ask first" | **Not enforced by any single gateway feature today.** See the risks in section 6. |
| Status on demand ("what's everyone doing?") | Grok Bot group chats (above) | `get_activity`, `list_conversations`, `list_delegates`, the Agent tree |
| One persistent memory of the user's preferences and projects | Pulse's dependence on memory; Grok Bot's per-bot memory | `memory_*` tools, `save_memory`, the wiki |
| Interruptible, and the user can correct it | Microsoft's 18 Guidelines for Human-AI Interaction (e.g. "support efficient dismissal", "support efficient correction"): https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/ | `steer`, `stop_conversation`, the Stop button |
| Show what it is unsure of; keep a log you can inspect | Same guidelines; dots lets you watch its computer | Terminal view, Agent tree, Jev confidence |
| Plan first, then act, so text the bot reads cannot add new actions | arXiv 2506.08837 (plan-then-execute, dual LLM): https://arxiv.org/pdf/2506.08837 · CaMeL: https://arxiv.org/pdf/2503.18813 | Not present. This would be new for the Bot. |
| Keep the bot simple; prefer a workflow over autonomy when you can | https://www.anthropic.com/engineering/building-effective-agents | Delegates and autopilot already exist |

---

## 3. Voice (as of Oct 2026)

| Option | Status | Indonesian / mixed Indonesian-English | Tool calls mid-call | Barge-in | Price per hour (my own estimate*) | Self-host |
|---|---|---|---|---|---|---|
| OpenAI Realtime `gpt-realtime-2.1` / mini | API is GA | **Not documented** (Whisper lists `id`) | Yes | Yes. The server handles it over WebRTC; over WebSocket your client must trim the unplayed audio. | about $2.9 (mini about $0.9) | No |
| OpenAI GPT-Live-1 (full duplex) | GA/preview status not stated | Not documented | Yes, and it can hand work to a backend agent | Full duplex | $3.00 (published $0.05/min) plus the backend model | No |
| Gemini Live `gemini-3.8-live` | Model listed as Stable, but the guide still calls the Live API "preview" (the docs disagree) | **`id` is listed, and the docs say native audio "can switch between languages naturally"** | Yes, asynchronous: it keeps talking while a tool runs | Yes. Voice activity detection cancels the reply and pending tool calls. | about $0.7–0.9 | No. Sessions last 15 min without session management. |
| ElevenLabs Agents | GA | Speech-to-text and text-to-speech are fine in Indonesian. **Indonesian in Agents itself is not confirmed**, and the docs contradict each other on switching language mid-call. | Yes, and you can bring your own LLM | Yes | $4.80 plus the LLM | No |
| Deepgram Voice Agent | GA | Nova-3 supports `id`, but **its mixed-language mode and its Aura TTS do not include Indonesian** | Yes | Not documented | $3.9–4.5 | Enterprise only |
| Claude | **No realtime voice API.** The consumer app's voice mode is beta. | Not named | Only in the consumer app | Turn-based | n/a | n/a |
| Self-hosted: faster-whisper, Piper `id_ID`, LiveKit or Pipecat | Open source | Whisper handles `id` but mixed language is undocumented. Piper has one Indonesian voice. Kokoro has none. LiveKit's turn detector supports Indonesian. | Through the orchestration layer | LiveKit and Pipecat handle it | Hardware cost only | Yes |

\* Per-hour figures assume 30 minutes of user speech and 30 of bot speech per hour, and exclude re-sending the conversation history. Real bills are higher. Latency is **not documented** for any of these, except ElevenLabs' speech models (Flash about 75 ms, v3 about 280 ms, excluding network).

Sources:
- OpenAI: https://developers.openai.com/api/docs/guides/realtime · https://developers.openai.com/api/docs/pricing · https://developers.openai.com/api/docs/models/gpt-live-1
- Gemini: https://ai.google.dev/gemini-api/docs/live-guide · https://ai.google.dev/gemini-api/docs/pricing
- ElevenLabs: https://elevenlabs.io/pricing/api · https://elevenlabs.io/docs/overview/models
- Deepgram: https://deepgram.com/pricing · https://developers.deepgram.com/docs/models-languages-overview
- Claude: https://support.claude.com/en/articles/11101966-using-voice-mode · https://platform.claude.com/docs/en/release-notes/overview
- LiveKit: https://docs.livekit.io/agents/build/turns/turn-detector/
- Pipecat: https://docs.pipecat.ai/server/services/supported-services

What this means:
- **The gateway is built on Claude, so v2 voice needs either a separate speech-to-speech model or a speech-to-text → Claude → text-to-speech pipeline.**
- **For mixed Indonesian and English speech, Gemini Live is the only option whose docs support it.**
- **WebRTC vs WebSocket:** OpenAI recommends WebRTC for browsers and phones, and with WebRTC the server trims interrupted audio for you. Gemini supports only WebSocket natively, or WebRTC through LiveKit. https://developers.openai.com/api/docs/guides/realtime-websocket
- **Cheapest first step: voice notes.** Telegram bots can download files up to 20 MB and send replies with `sendVoice` (OGG/Opus). https://core.telegram.org/bots/api
  - Transcribing a one-minute note costs about $0.003–0.0045.
  - OpenAI's speech-to-text docs don't list OGG, so convert the note first. https://developers.openai.com/api/docs/guides/speech-to-text

---

## 4. Channels for one user in Indonesia

| Channel | Cost | Approve/deny buttons | Voice | Main catch |
|---|---|---|---|---|
| **Telegram bot** | Free | Inline keyboard, answered through `callback_query` | Voice notes in and out | About 1 message per second per chat. Long polling needs no public URL. https://core.telegram.org/bots/faq |
| Existing panel PWA plus web push | Free (already built) | **No notification buttons on iOS**, so you open the app to approve. https://caniuse.com/mdn-api_notification_actions | In the browser | iOS 16.4+ and a Home Screen install are required. https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/ |
| WhatsApp Cloud API | Indonesia from 1 Oct 2026: utility and service about $0.025 (Rp357) per message after 1,000 free service messages a month | Yes | Yes (16 MB) | Templates outside the 24-hour window. **Meta's terms §4.7 prohibit AI as the "main function" since 15 Jan 2026.** https://developers.facebook.com/docs/whatsapp/pricing · https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform |
| Unofficial WhatsApp (Baileys, whatsapp-web.js) | Free | Limited | Yes | Breaks WhatsApp's terms and risks a ban. A trojanized Baileys package stole sessions in Dec 2025. https://thehackernews.com/2025/12/fake-whatsapp-api-package-on-npm-steals.html |
| Slack | Free plan | Block Kit | No | Free plan keeps 90 days of history and allows 10 apps. https://slack.com/help/articles/7050776459923 |
| iMessage | n/a | n/a | n/a | No bot API. Messages for Business requires an Apple-approved provider, and Indonesian availability is unknown. https://register.apple.com/resources/messages/messaging-documentation/ |

Two notes:
- The WhatsApp pricing page disagrees with itself: the English copy still says non-template messages are free, while the dated Indonesian copy and the rate card say otherwise.
- My assessment: Telegram first and the existing panel second. WhatsApp's AI clause is a real risk to the account, and Meta decides whether a personal relay bot counts.

---

## 5. Build or adopt

Star counts were read on 14 Oct 2026 and not rechecked (the GitHub API was rate-limited). The OpenClaw and Hermes counts are unusually high, so treat them as unverified.

| Project | Stars / latest release | Fit for a bot that only delegates |
|---|---|---|
| **OpenClaw** (formerly Clawdbot, then Moltbot) | 392k / v2026.10.3, 13 Oct 2026 | It has 20+ channels and an MCP client, so it could serve as the channel layer. But its security record is poor: CVE-2026-25253 (one-click remote code execution), the "ClawHavoc" malicious skills, and many exposed instances. https://docs.openclaw.ai/cli/mcp · https://blog.barrack.ai/openclaw-security-vulnerabilities-2026/ · Given the cryptojacking incident on valbox in August, I would not run it there. |
| Hermes Agent (Nous Research) | 254k / v0.22.0 | Its multi-channel support, cron and subagents duplicate the gateway. https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp |
| nanobot (HKUDS) | 49k / v0.3.5 | The best thin-wrapper candidate: small core, MCP, cron. |
| Letta (MemGPT) | 25k / 0.16.8, May 2026 | Strong on memory, but the V1 server was retired in favour of letta-code, so expect churn. https://docs.letta.com/guides/mcp/overview |
| Open Interpreter | 69k | Now a coding agent (a fork of Codex). Doesn't fit. https://github.com/openinterpreter/openinterpreter |
| Home Assistant voice | Core 2026.10.1. The Voice PE device ($69) is still labelled "Preview". | Indonesian speech-to-text and text-to-speech are **cloud only**, so a fully local Indonesian voice isn't possible. https://www.home-assistant.io/voice-pe/ |
| **Claude Agent SDK** (Python and TypeScript, both released 14 Oct 2026) | 8.3k / 1.8k | Connects to an http MCP server with a bearer token, and `allowedTools` restricts which tools it can call. That makes a tool allowlist straightforward. https://code.claude.com/docs/en/agent-sdk/mcp |
| OpenAI Agents SDK, Pipecat 1.12, Vercel AI SDK | 30k / 16.5k / 27k | Pipecat is the obvious voice front end for v2. https://docs.pipecat.ai/server/utilities/mcp/mcp |

- **The `openclaw` reference:** it is not in the container's crontab and not on PATH. The only mention in this repo is `/home/efran/remote-development/x056-remote-control/docs/research-2026-08-13-memory-and-toolkit.md`, where OpenClaw is one target of a memory plugin. I did not check the host crontab on valbox.
- **My assessment:** don't adopt a framework. The gateway already does what OpenClaw and Hermes offer. The only missing pieces are a channel adapter and a constrained bot persona.

---

## 6. Recommendation and phased plan (assessment)

**v0: text bot, 3–5 days**
- Make the Bot a gateway conversation in a dedicated "Bot" project, with a system prompt and a **tool allowlist**:
  - Read tools: `get_activity`, `list_conversations`, `read_conversation`, `list_delegates`, `memory_search`, `memory_read`.
  - Write tool: `send_message` only, through the approval gate.
- Add a Telegram adapter, using long polling (no public URL needed) and inline approve/deny buttons that call the existing approval endpoint. Lock it to your own Telegram chat ID only.
- Because it runs as a gateway conversation, it uses the flat-rate Max accounts and failover. A separate Agent SDK process would pay API rates per token. I did not verify that billing detail.

**v1: proactive monitoring and briefings, 5–8 days**
- A morning and evening digest through `schedule_task`, finite in the Pulse style.
- Threshold watchers (failed turn, a question waiting, a delegate blocked, cost spikes) that reuse the existing `noticeFor` tiers instead of a second notification system.
- Copy the dots split:
  - **The monitoring loop gets read-only tools only.**
  - Write tools exist only on turns you started.
  - Per-action rules: allow, ask first, or block.
- Preferences go into memory through `memory_propose`, which needs your approval.

**v2: voice, 7–12 days**
- Start with Telegram voice notes in both directions: Whisper or Scribe for speech-to-text, Piper `id_ID` or ElevenLabs for the reply. This costs cents per day.
- Then add live voice in the panel. Two options:
  - **Recommended:** Gemini Live, because of Indonesian/English code-switching. It calls a small "bridge" tool that forwards requests to the Claude Bot.
  - Alternative: Pipecat or LiveKit around speech-to-text → Claude → text-to-speech.

### Biggest risks
- **Approval-gate bypass.** The gate covers `send_message`. Delegates run with "no approval (hard limits only)". A delegate's steer into its orchestrator skips approval. `stop_conversation` is ungated on purpose. A Bot holding `delegate`, `steer`, `schedule_task` or `create_chat` can therefore act without your gate. **Use an explicit allowlist, and either exclude those tools or gate them in v1.**
- **Prompt injection through monitored content.** `read_conversation` returns other sessions' transcripts, which contain fetched web pages and email. Reading those, plus `send_message` into a session with network and secret access, is Willison's "lethal trifecta" (private data, untrusted content, and a way to send data out). https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
  - Mitigations: plan-then-execute, quarantined summaries, and a read-only monitoring loop. https://arxiv.org/pdf/2506.08837
- **Telegram identity.** Anyone who finds the bot can message it. Check the chat ID and the webhook secret.
- **Cost.**
  - A proactive loop polling every N minutes uses up Max quota. Prefer event-driven watchers over polling.
  - Live voice costs about $1–5 per hour plus context.
  - Grok Bot users ran out of their weekly quota in about 3 days, which is what an always-on agent does to a budget.
- **Latency.** Voice tool calls that wait on a Claude turn take seconds. Asynchronous tools (Gemini's `NON_BLOCKING`) and a "working on it, I'll notify you" pattern hide that wait.