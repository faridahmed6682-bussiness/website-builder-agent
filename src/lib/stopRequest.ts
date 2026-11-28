// Stop intent in a chat message — the user telling the agent to stop the
// running work, in Bengali or English (case-insensitive, surrounding
// words allowed). Used by App.tsx: while work is running, a stop message
// cancels the work instead of starting a new turn.
//
// Bengali matches on the word root, so থামো / থামাও / থামুন and
// বন্ধ করো / বন্ধ কর / কাজ বন্ধ করো all match. English matches on whole
// words (stop, stopped, stopping, cancel, cancelled, canceling) so
// "stopwatch" and "nonstop" do not count, but "stop", "stop the work",
// "stop running" and "cancel" do.
export function isStopRequest(text: string): boolean {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  if (t.includes('থাম') || t.includes('বন্ধ কর') || t.includes('কাজ বন্ধ')) return true;
  return /\b(stop|stopped|stopping|cancel|cancelled|canceled|cancelling|canceling)\b/i.test(t);
}
