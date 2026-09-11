# RC Chat build review

Built and tested. Deployment is on hold.

- Chat with provider, model, effort, and account controls.
- File uploads, saved versions, restore, download, and document previews.
- Plugins, MCP, skills, and required-tool routing.
- Project references and messaging through existing controls.

Real DOCX work continued across two accounts on each provider.
The regression suite passed 829 tests. Desktop, mobile, and document checks passed.

Codex's connector-directory check currently returns HTTP 403. Unverified plugins remain visible as installed.

Future releases will serve the panel from the built image. Further edits use an isolated checkout.

![Desktop Chat with saved files](https://x056.think.val.id/rc-chat-desktop-20260911.png)

![DOCX preview](https://x056.think.val.id/rc-chat-document-20260911.png)

![Mobile file panel](https://x056.think.val.id/rc-chat-mobile-20260911.png)
