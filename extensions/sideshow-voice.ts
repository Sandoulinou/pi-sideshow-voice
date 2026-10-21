// pi-sideshow-voice
//
// Bridges sideshow push-to-talk transcripts into Pi. The sideshow server
// transcribes each take (same Parakeet model as pi-voicekit) and queues the
// text in its voice inbox; this extension polls that inbox and delivers each
// transcript through pi.sendUserMessage — exactly the path pi-voicekit's
// auto-submit-on-speak uses (deliverAs: "followUp").
//
// Delivering doubles as a claim: the first extension to POST the deliver
// endpoint wins; concurrent Pi sessions get a 409 and skip, so a transcript
// reaches exactly one session. Once claimed, the send is retried a few times
// before being surfaced as a warning, so a transient failure doesn't drop
// the take silently.
//
// Result round-trip: after handing the transcript to the agent, we remember
// the voice job id and watch for the run to settle. The last assistant reply
// produced is POSTed back to the server (`/api/voice/jobs/:id/result`), which
// publishes it as a new card next to the voice note and flips the card's
// footer progress to done. If no reply is produced (e.g. the agent was busy
// with an unrelated turn) nothing is posted — the note keeps its text.
//
// Config: SIDESHOW_URL (default http://127.0.0.1:8228). No token by default —
// the local server runs without auth, mirroring how the viewer talks to it.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SIDESHOW_URL = (process.env.SIDESHOW_URL ?? "http://127.0.0.1:8228").replace(/\/$/, "");
const POLL_MS = 2000;
const SEND_RETRIES = 3;

interface InboxItem {
  id: string;
  jobId: string;
  transcript: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Concatenate the text blocks of an assistant message; "" if it has none.
function assistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown };
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
  return m.content
    .map((c) => {
      const b = c as { type?: string; text?: unknown };
      return b && b.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let busy = false;
  // The voice job awaiting its Pi reply, plus the latest assistant text since
  // we sent the transcript (reset on send so a stale reply isn't posted).
  let pendingJobId: string | null = null;
  let lastAssistantText = "";

  // Track the newest assistant reply so we can ship it when the run settles.
  pi.on("message_end", (event) => {
    const text = assistantText(event.message);
    if (text) lastAssistantText = text;
  });

  // A settled run means no queued continuation will follow — the right moment
  // to decide the voice reply is final.
  pi.on("agent_settled", () => {
    if (!pendingJobId) return;
    const jobId = pendingJobId;
    pendingJobId = null;
    const result = lastAssistantText;
    lastAssistantText = "";
    if (!result) return;
    fetch(`${SIDESHOW_URL}/api/voice/jobs/${jobId}/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ result }),
    }).catch((err) => {
      console.warn("[pi-sideshow-voice] failed to post result:", String(err));
    });
  });

  const poll = async () => {
    if (busy) return;
    let items: InboxItem[] = [];
    try {
      const res = await fetch(`${SIDESHOW_URL}/api/voice/inbox`);
      if (!res.ok) return;
      items = (await res.json()) as InboxItem[];
    } catch {
      return; // sideshow server not running — nothing to do
    }
    for (const item of items) {
      busy = true;
      try {
        // Claim first (first POST wins) so exactly one Pi session receives
        // the transcript.
        const dres = await fetch(`${SIDESHOW_URL}/api/voice/inbox/${item.id}/deliver`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client: `pi:${process.pid}` }),
        });
        if (dres.status === 409) continue; // another Pi session claimed it
        if (!dres.ok) continue;

        // Arm the result round-trip, then hand the transcript to the agent as
        // a user message — the same call pi-voicekit auto-submit makes.
        lastAssistantText = "";
        pendingJobId = item.jobId;

        let sent = false;
        for (let attempt = 0; attempt < SEND_RETRIES && !sent; attempt++) {
          try {
            await pi.sendUserMessage(item.transcript, { deliverAs: "followUp" });
            sent = true;
          } catch (err) {
            if (attempt < SEND_RETRIES - 1) {
              await sleep(500 * (attempt + 1));
            } else {
              pendingJobId = null; // give up on the round-trip too
              console.warn(
                "[pi-sideshow-voice] sendUserMessage failed after retries:",
                String(err),
              );
            }
          }
        }
      } catch {
        // Claim failed mid-flight — retry on the next poll.
      } finally {
        busy = false;
      }
    }
  };

  const timer = setInterval(() => {
    void poll();
  }, POLL_MS);
  timer.unref?.();
  void poll();

  pi.on("session_shutdown", () => {
    clearInterval(timer);
  });
}
