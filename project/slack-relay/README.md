# Ernest Ops Slack Relay

Google Apps Script that lets Claude scheduled tasks post to Slack as the
**Ernest Ops** bot (so the posts notify Nick) instead of as Nick's own user.

Cloud sandboxes cannot reach Slack, so Claude sends an email instead. The
script polls Gmail every minute and posts each matching email to Slack.

## Sending a message

Email `nward@ernestperformance.com.au` with `[SLACK-RELAY]` in the subject and
this body:

```
CHANNEL: C0BJK0PH2JX

Message text. Slack mrkdwn passes through.
```

Channel IDs: `#witb` is `C0BJK0PH2JX`, `#ep-operations` is `C0BG5NWRWLA`.
Without a `CHANNEL:` line the message goes to `#witb`.

Only email from the account itself (or `ALLOWED_SENDERS`) is relayed. Relayed
emails are archived and labelled `slack-relayed`; rejected posts get
`slack-relay-failed`.

## Where things live

- Code: `SlackRelay.gs` (this folder) mirrors the Apps Script project
  **Ernest Ops Slack Relay** on script.google.com.
- Bot token: Script Property `SLACK_BOT_TOKEN` on that project only. Never in
  this repo.
- Slack app: **Ernest Ops** (bot user `ernest_ops`), scopes `chat:write` and
  `chat:write.public`, at https://api.slack.com/apps.

## Notifications

A bot post only pushes to the phone if the channel's notification setting is
**All new messages** (as on `#ep-bills`) and the Slack desktop app is not
active. Both were verified on 8 Sep 2026.
