/**
 * Ernest Ops Slack Relay
 *
 * Google Apps Script that turns emails into Slack posts from the "Ernest Ops"
 * bot. Claude (or anything else that can send email) writes to the account's
 * own address with "[SLACK-RELAY]" in the subject and a body like:
 *
 *   CHANNEL: C0BJK0PH2JX
 *
 *   Message text here. Slack mrkdwn is passed through untouched.
 *
 * A time-driven trigger runs relay() every minute. Each matching email is
 * posted to the named channel, then archived and labelled "slack-relayed".
 *
 * Script Properties (Project Settings > Script Properties):
 *   SLACK_BOT_TOKEN   required. Bot User OAuth Token (xoxb-...).
 *   DEFAULT_CHANNEL   optional. Used when the body has no CHANNEL: line.
 *                     Defaults to #witb.
 *   ALLOWED_SENDERS   optional. Comma-separated emails allowed to relay.
 *                     Defaults to the account running the script.
 *
 * One-time setup: run setup() once from the editor. It asks for the Gmail and
 * network permissions, creates the labels, and installs the trigger.
 */

var SUBJECT_TAG = '[SLACK-RELAY]';
var LABEL_DONE = 'slack-relayed';
var LABEL_FAILED = 'slack-relay-failed';
var FALLBACK_CHANNEL = 'C0BJK0PH2JX'; // #witb
var TEST_CHANNEL = 'C0BJK0PH2JX';     // #witb
var SEARCH_WINDOW = 'newer_than:3d';
var MAX_TRACKED_IDS = 500;
var SLACK_TEXT_LIMIT = 39000;

/** Runs every minute via the trigger installed by setup(). */
function relay() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SLACK_BOT_TOKEN');
  if (!token) throw new Error('Script property SLACK_BOT_TOKEN is not set.');

  var allowed = allowedSenders_(props);
  var processed = loadProcessed_(props);
  var doneLabel = getOrCreateLabel_(LABEL_DONE);
  var failedLabel = getOrCreateLabel_(LABEL_FAILED);

  var query = 'subject:"' + SUBJECT_TAG + '" -in:trash -in:spam ' + SEARCH_WINDOW;
  var threads = GmailApp.search(query, 0, 50);
  var changed = false;

  threads.forEach(function (thread) {
    var messages = thread.getMessages();
    var anyFailure = false;
    var anySuccess = false;

    messages.forEach(function (msg) {
      var id = msg.getId();
      if (processed.indexOf(id) !== -1) return;
      if (msg.getSubject().indexOf(SUBJECT_TAG) === -1) return;

      var sender = extractEmail_(msg.getFrom());
      if (allowed.indexOf(sender) === -1) {
        Logger.log('Skipping message %s from unlisted sender %s', id, sender);
        processed.push(id);
        changed = true;
        return;
      }

      var parsed = parseBody_(msg.getPlainBody(), props);
      if (!parsed.text) {
        Logger.log('Message %s has an empty body after the CHANNEL line; skipping.', id);
        processed.push(id);
        changed = true;
        anyFailure = true;
        return;
      }

      var result = postToSlack_(token, parsed.channel, parsed.text);
      if (result.ok) {
        anySuccess = true;
        Logger.log('Relayed message %s to %s (ts %s)', id, parsed.channel, result.ts);
      } else {
        anyFailure = true;
        Logger.log('Slack rejected message %s for %s: %s', id, parsed.channel, result.error);
      }
      processed.push(id);
      changed = true;
    });

    if (anySuccess) thread.addLabel(doneLabel);
    if (anyFailure) thread.addLabel(failedLabel);
    if (anySuccess || anyFailure) {
      thread.markRead();
      thread.moveToArchive();
    }
  });

  if (changed) saveProcessed_(props, processed);
}

/** Posts a fixed message to #witb so you can confirm the token and channel. */
function testRelay() {
  var token = PropertiesService.getScriptProperties().getProperty('SLACK_BOT_TOKEN');
  if (!token) throw new Error('Script property SLACK_BOT_TOKEN is not set.');
  var result = postToSlack_(
    token,
    TEST_CHANNEL,
    ':white_check_mark: *Ernest Ops relay test* from Apps Script at ' +
      Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss z')
  );
  Logger.log(JSON.stringify(result));
  if (!result.ok) throw new Error('Slack error: ' + result.error);
  return result;
}

/** Run once from the editor: authorises scopes, creates labels, installs the trigger. */
function setup() {
  getOrCreateLabel_(LABEL_DONE);
  getOrCreateLabel_(LABEL_FAILED);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'relay') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('relay').timeBased().everyMinutes(1).create();

  Logger.log('Trigger installed: relay() every minute. Labels ready.');
}

/** Removes the relay trigger. Use if you ever want to pause the relay. */
function teardown() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'relay') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Relay trigger removed.');
}

// ---------------------------------------------------------------------------

function postToSlack_(token, channel, text) {
  if (text.length > SLACK_TEXT_LIMIT) {
    text = text.substring(0, SLACK_TEXT_LIMIT) + '\n_(truncated by relay)_';
  }
  var response = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: channel, text: text, unfurl_links: false }),
    muteHttpExceptions: true
  });
  var body;
  try {
    body = JSON.parse(response.getContentText());
  } catch (e) {
    return { ok: false, error: 'HTTP ' + response.getResponseCode() + ' non-JSON response' };
  }
  if (!body.ok) return { ok: false, error: body.error || ('HTTP ' + response.getResponseCode()) };
  return { ok: true, ts: body.ts, channel: body.channel };
}

/**
 * Body format: an optional "CHANNEL: <id or #name>" line, then the message.
 * Blank lines before and after the CHANNEL line are dropped. Quoted reply
 * text (lines starting with ">") is not stripped; the relay is meant for
 * fresh emails, not replies.
 */
function parseBody_(plain, props) {
  var lines = (plain || '').replace(/\r\n?/g, '\n').split('\n');
  var channel = props.getProperty('DEFAULT_CHANNEL') || FALLBACK_CHANNEL;
  var start = 0;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line === '') continue;
    var m = line.match(/^CHANNEL:\s*(\S+)\s*$/i);
    if (m) {
      channel = m[1];
      start = i + 1;
    }
    break;
  }

  var text = lines.slice(start).join('\n').trim();
  return { channel: channel, text: text };
}

function allowedSenders_(props) {
  var raw = props.getProperty('ALLOWED_SENDERS');
  var list = raw ? raw.split(',') : [Session.getEffectiveUser().getEmail()];
  return list.map(function (s) { return s.trim().toLowerCase(); }).filter(String);
}

function extractEmail_(from) {
  var m = (from || '').match(/<([^>]+)>/);
  return (m ? m[1] : from || '').trim().toLowerCase();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function loadProcessed_(props) {
  try {
    return JSON.parse(props.getProperty('PROCESSED_IDS') || '[]');
  } catch (e) {
    return [];
  }
}

function saveProcessed_(props, ids) {
  if (ids.length > MAX_TRACKED_IDS) ids = ids.slice(ids.length - MAX_TRACKED_IDS);
  props.setProperty('PROCESSED_IDS', JSON.stringify(ids));
}
