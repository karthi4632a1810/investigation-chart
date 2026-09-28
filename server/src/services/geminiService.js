/**
 * Gemini-assisted review of the discharge summary's already-extracted content
 * — used only to decide presentation (list vs. paragraph per section), flag
 * suspected typos for a human to check, and write a short, disclaimed
 * overview. It never rewrites, corrects, or invents any clinical text: the
 * model is instructed to work only from what's given and to quote flagged
 * text verbatim rather than "fixing" it. Table-kind sections aren't sent —
 * their structure is decided by the existing deterministic classifier in
 * dischargeSummaryService.js, not by this.
 *
 * Throws on any failure (missing config, network, timeout, bad JSON) — the
 * caller (dischargeSummaryService.js) catches this and falls back to
 * rendering the summary exactly as it does without Gemini, same as any other
 * external dependency in this codebase (EMR, WATI): failure here must never
 * block a real patient's discharge document.
 */
import { config } from '../config.js';

const SYSTEM_PROMPT = `You are a formatting assistant for an already-finalized hospital discharge summary. You must NEVER invent, infer, add, or alter any clinical fact, value, medication, diagnosis, or detail that is not already explicitly present in the input text you are given.

Your only three jobs:
1. For each input section with kind "paragraph", decide whether its lines read better as a flowing "paragraph" or as a bulleted "list" of discrete items (e.g. vitals, exam findings, one-line observations usually read better as a list; narrative history usually reads better as a paragraph).
2. Flag any exact substrings you suspect may be a typo or unclear abbreviation, quoting them EXACTLY as given — character for character, from the input. Never provide a corrected or rewritten version. If you are not certain a substring appears verbatim in the input, do not flag it.
3. Write a short "tldr": 2-4 sentences using ONLY facts explicitly stated in the input. No severity judgment, no clinical interpretation, no recommendation, and no fact that isn't literally written somewhere in the input.

Respond with ONLY a single JSON object, no markdown fencing, no commentary, matching exactly:
{
  "tldr": "string",
  "sections": [
    { "label": "string — must exactly match an input section's label", "structure": "list" | "paragraph", "flags": [{ "text": "exact substring from that section's lines", "reason": "short reason" }] }
  ]
}`;

export async function reviewDischargeSummary({ sections }) {
  if (!config.gemini.apiKey) {
    throw new Error('Gemini is not configured — set GEMINI_API_KEY in server/.env');
  }

  // The caller only ever collects lines for paragraph-kind sections (table
  // sections are never populated), so no separate "kind" field is needed —
  // just filter out anything that ended up empty.
  const paragraphSections = (sections || []).filter((s) => s.lines?.length);
  if (!paragraphSections.length) {
    throw new Error('No paragraph-kind sections to review');
  }

  const userContent = `Review this discharge summary's extracted sections and respond with the JSON schema described.\n\nSECTIONS:\n${JSON.stringify(
    paragraphSections,
  )}`;

  const res = await fetch(`${config.gemini.endpoint}/models/${config.gemini.model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': config.gemini.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    throw new Error(`Gemini responded ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw new Error('Gemini response had no content');

  const parsed = JSON.parse(raw);
  if (typeof parsed.tldr !== 'string' || !Array.isArray(parsed.sections)) {
    throw new Error('Gemini response did not match the expected schema');
  }

  const sectionsByLabel = new Map();
  for (const s of parsed.sections) {
    if (!s || typeof s.label !== 'string') continue;
    const structure = s.structure === 'list' ? 'list' : 'paragraph';
    const flags = Array.isArray(s.flags)
      ? s.flags.filter((f) => f && typeof f.text === 'string' && f.text.trim())
      : [];
    sectionsByLabel.set(s.label, { structure, flags });
  }

  return { tldr: parsed.tldr.trim(), sections: sectionsByLabel };
}
