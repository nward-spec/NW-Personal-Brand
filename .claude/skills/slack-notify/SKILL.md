---
name: slack-notify
description: Send Nick a Slack message that actually reaches his phone, posted by the "Ernest Ops" bot through the email relay. Use this whenever a task needs Nick to see something in Slack - an approval request, a run report, a failure, a reminder, a "ready for review", a scheduled-task summary - even if the request just says "post to Slack" or "let me know". Always prefer this over the Slack connector's send_message, which posts as Nick's own user and therefore never notifies him (an approval once sat unseen for four days that way).
---

# Slack notify (via the Ernest Ops relay)

## Why this exists

Messages sent through the Slack connector go out as Nick's own account. Slack
never notifies you about your own messages, so those posts are invisible until
he happens to open the channel. Cloud sessions also cannot reach Slack
directly. The fix is a relay: you send an email, a Google Apps Script running
on Google's servers polls Gmail every minute and posts the body to Slack as the
**Ernest Ops** bot. Bot posts push to his phone like any other app.

## How to send one

Use the Gmail connector's `send_message` tool. Nothing else is needed.

- **to**: `nward@ernestperformance.com.au`
- **subject**: `[SLACK-RELAY] <short unique title>` - the tag is what the relay
  searches for; the title is for Nick's Gmail only and is never posted.
- **body** (plain text `body`, not `htmlBody` - the relay reads the plain part
  and HTML conversion can mangle Slack formatting):

```
CHANNEL: <channel id>

<message>
```

The first non-blank line must be the `CHANNEL:` line. Everything after it is
posted verbatim. If the line is missing, the message goes to #witb.

### Channels

| Channel        | ID            | Use for                                   |
|----------------|---------------|-------------------------------------------|
| #witb          | `C0BJK0PH2JX` | WITB carousel runs, approvals, reminders  |
| #ep-operations | `C0BG5NWRWLA` | Ernest Performance ops and pipeline runs  |

For any other channel, ask Nick for the ID or find it with the Slack
connector's `slack_search_channels`. Public channels work without an invite.
A private channel needs `/invite @Ernest Ops` first.

## Writing the message

The message lands on a phone lock screen, so the first line does the work.

- Lead with the ask or the outcome. "Approve the Clark WITB?" beats "Morning
  Nick, here's an update".
- Slack mrkdwn, not Markdown: `*bold*`, `_italic_`, `<https://url|label>`,
  bullet lines with `•` or `-`. No `#` headers, no `**double stars**`,
  no Markdown tables.
- Keep it under roughly 3,000 characters. Long reports belong in an artifact
  or document; link to it and summarise. Hard limit is 39,000, after which the
  relay truncates.
- One event, one message. Don't send a stream of progress updates; send one
  when there is something Nick has to read or act on.
- For approvals, say exactly what a reply should look like ("thumbs up here =
  approved, reply with changes, thumbs down = stop"). The bot does not read
  replies; the next run reads them from the channel with the Slack connector.

## After sending

Delivery takes up to about 90 seconds. You do not need to wait. If the task
has time and the outcome matters (an approval request, a failure alert), you
can confirm with the Slack connector's `slack_read_channel` on the channel ID.
If the message never appears, search Gmail for `label:slack-relay-failed`:
the relay labels an email that Slack rejected, usually a wrong channel ID.

## When the Gmail connector is not available

Fall back to the Slack connector's `slack_send_message` so the content is at
least in the channel, and say plainly in your final report that the message
was posted as Nick and will not have notified him. Do not silently skip the
notification.

## Example

Task: the WITB carousel is rendered and needs sign-off.

`send_message` with:

- to: `nward@ernestperformance.com.au`
- subject: `[SLACK-RELAY] Clark WITB ready for review`
- body:

```
CHANNEL: C0BJK0PH2JX

*Wyndham Clark WITB is ready for review.* 7 slides, breeze theme, all 1080x1350.
Review: <https://claude.ai/code/artifact/788758ee|carousel>
Recommended slot: 19:00 Melbourne tonight.

:+1: here = approved. Reply with changes and I will re-render. :-1: = stop.
```

Within a minute this appears in #witb from Ernest Ops and pushes to his phone.

## Relay internals

The relay script, its README and the token location are documented in
`project/slack-relay/` in the NW-Personal-Brand repo. The bot token is only in
the Apps Script project's Script Properties; never put it in a message, file or
repo.
