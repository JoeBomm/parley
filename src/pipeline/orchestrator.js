import { transcribeTracks } from './transcribe.js';
import { buildTranscript, computeTalkTime } from './summarize.js';
import { getSummarizer } from '../adapters/summarizer/index.js';
import { describeSummarizerError } from '../adapters/summarizer/errors.js';
import { resolveSummaryLanguage } from '../adapters/summarizer/languages.js';

export async function processMeeting(db, meetingId, opts) {
  const meeting = db.getMeeting(meetingId);
  const transcribe = opts.transcribe || ((tracks, cfg) => transcribeTracks(tracks, cfg));
  const summarizer = opts.summarizer || getSummarizer(opts.cfg);

  db.setMeetingStatus(meetingId, 'processing');

  let utterances;
  let failures = [];
  try {
    const result = await transcribe(opts.tracks, opts.cfg);
    // transcribeTracks returns { utterances, failures }, but opts.transcribe
    // is an injectable seam other callers/tests still use to return a bare
    // utterances array — accept both shapes.
    if (Array.isArray(result)) {
      utterances = result;
    } else {
      utterances = result.utterances;
      failures = result.failures || [];
    }
  } catch (err) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    err.userMessage = `Transcription failed — the STT sidecar may be down or unreachable. (${err.message})`;
    throw err;
  }

  // A2: one or more tracks failing STT must not sink a meeting that
  // otherwise has usable transcript — only bail out when every track
  // failed and nothing came through.
  if (failures.length > 0) {
    console.warn(`[orchestrator] ${failures.length} track(s) failed transcription for meeting ${meetingId}`);
  }
  if (utterances.length === 0 && failures.length > 0) {
    db.setMeetingStatus(meetingId, 'transcription_failed');
    const err = new Error(`All ${failures.length} track(s) failed transcription`);
    err.userMessage = `Transcription failed — the STT sidecar may be down or unreachable. (${err.message})`;
    throw err;
  }
  for (const u of utterances) db.addUtterance({ meetingId, ...u });

  // Nobody actually spoke (bot joined an empty/near-silent channel). Don't
  // summarize or deliver — signal the caller to discard the meeting so these
  // empties never clutter the archive.
  if (utterances.length === 0) {
    db.setMeetingStatus(meetingId, 'empty');
    return { notes: null, talktime: [], empty: true };
  }

  const transcript = buildTranscript(utterances);
  const talktime = computeTalkTime(utterances);
  const attendees = db.listAttendees(meetingId).map((a) => a.display_name);
  const meta = {
    channelName: meeting.channel_name,
    date: meeting.started_at,
    attendees,
    summaryLanguage: resolveSummaryLanguage(opts.cfg),
  };

  let notes;
  try {
    notes = await summarizer.summarize(transcript, meta);
  } catch (err) {
    db.setMeetingStatus(meetingId, 'summary_failed');
    err.userMessage = describeSummarizerError(err, opts.cfg.summarizerProvider);
    throw err;
  }

  const modelUsed = `${opts.cfg.summarizerProvider}:${opts.cfg.summarizerModel || ''}`;
  db.saveSummary(meetingId, notes, talktime, modelUsed);
  db.seedTodos(meetingId, meeting.guild_id, notes.actionItems || []);
  db.setMeetingStatus(meetingId, 'done', new Date().toISOString());

  if (opts.deliver) await opts.deliver(notes, talktime, meta);
  return { notes, talktime };
}
