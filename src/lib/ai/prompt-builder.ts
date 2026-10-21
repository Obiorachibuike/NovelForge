/**
 * Prompt builders for the hosted-inference path.
 *
 * Two goals: give image models enough structure to produce a usable book cover,
 * and give text models a *compact* story memory so sequential chapter
 * generation stays coherent without shipping the whole novel on every request.
 *
 * Capability awareness: only parameters a model is known to support are used.
 * Negative prompts are sent only when the model's `supportsNegativePrompt` flag
 * is verified; otherwise they are folded into the positive prompt so the
 * instruction survives.
 */
import type { ModelRow } from './types';

export interface CoverPromptInput {
  title: string;
  genre?: string | null;
  tone?: string | null;
  audience?: string | null;
  premise?: string | null;
  characters?: Array<{ name?: string; role?: string; appearance?: string | null }> | string | null;
  setting?: string | null;
  visualMood?: string | null;
  composition?: string | null;
  style?: string | null;
}

export const DEFAULT_COVER_STYLE =
  'premium printed hardcover illustration, dramatic cinematic lighting, rich colour grading, print-ready';

export interface BuiltCoverPrompt {
  prompt: string;
  negativePrompt?: string;
  /** True when the title was intentionally kept out of the image. */
  omitLettering: boolean;
}

/**
 * Builds a cover prompt.
 *
 * Most diffusion models cannot render lettering reliably, so the title is
 * described as a *subject* and, unless the caller opts into lettering, the
 * prompt explicitly asks for no text in the image. NovelForge then composites
 * the title onto the cover (see the SVG/labelled placeholder path or the
 * export pipeline), which is why `omitLettering` is returned alongside.
 */
export function buildCoverPrompt(input: CoverPromptInput, model?: ModelRow | null): BuiltCoverPrompt {
  const parts: string[] = [];
  parts.push(`Book cover illustration for a ${input.genre || 'fiction'} novel titled "${input.title}".`);
  if (input.premise) parts.push(`Story concept: ${trim(input.premise, 320)}.`);
  const characterText = normaliseCharacters(input.characters);
  if (characterText) parts.push(`Central figure(s): ${characterText}.`);
  if (input.setting) parts.push(`Setting: ${trim(input.setting, 240)}.`);
  if (input.tone) parts.push(`Tone: ${trim(input.tone, 160)}.`);
  if (input.audience) parts.push(`Target audience: ${input.audience}.`);
  parts.push(
    input.composition
      ? `Composition: ${trim(input.composition, 240)}.`
      : 'Composition: portrait orientation, a single striking focal subject, negative space at the top third and bottom edge for the title and author name.',
  );
  parts.push(`Style: ${input.style || DEFAULT_COVER_STYLE}.`);
  if (input.visualMood) parts.push(`Visual mood: ${trim(input.visualMood, 200)}.`);
  parts.push('High detail, sharp focus, no watermark, no signature.');

  const negative = [
    'text, letters, words, titles, typography, captions, watermark, logo',
    'distorted hands, extra limbs, blurred faces, low resolution, jpeg artefacts',
  ].join(', ');

  // Only send a negative prompt when the model is verified to support it;
  // otherwise fold the constraint into the positive prompt.
  const supportsNegative = model?.supportsNegativePrompt === true;
  if (!supportsNegative) {
    parts.push(`Avoid: ${negative}.`);
    return { prompt: parts.join(' '), omitLettering: true };
  }
  return { prompt: parts.join(' '), negativePrompt: negative, omitLettering: true };
}

export interface StoryMemory {
  characters?: Array<{ name?: string; role?: string; appearance?: string | null; personality?: string | null; arc?: string | null }>;
  relationships?: Array<{ from?: string; to?: string; relation?: string; description?: string | null }>;
  settingRules?: string[];
  timeline?: Array<{ label?: string; when?: string | null; description?: string }>;
  majorEvents?: string[];
  openThreads?: string[];
  previousSummaries?: string[];
  styleNotes?: string[];
  continuityConstraints?: string[];
}

export interface CompactMemoryOptions {
  /** Hard character budget for the memory block (default ~4k characters). */
  maxChars?: number;
  maxPreviousSummaries?: number;
}

/**
 * Builds a bounded story-memory block for sequential chapter generation.
 *
 * Previous chapters are represented by their summaries only — never their full
 * text — and every section is truncated, so the prompt stays inside the context
 * window even for a 60-chapter novel.
 */
export function compactStoryMemory(memory: StoryMemory, options: CompactMemoryOptions = {}): string {
  const maxChars = options.maxChars ?? 4_000;
  const maxSummaries = options.maxPreviousSummaries ?? 3;
  const sections: string[] = [];

  if (memory.characters?.length) {
    const lines = memory.characters.slice(0, 10).map(c =>
      `- ${c.name || 'Unnamed'}${c.role ? ` (${c.role})` : ''}${c.personality ? `: ${trim(c.personality, 120)}` : ''}${c.arc ? ` Arc: ${trim(c.arc, 120)}` : ''}`,
    );
    sections.push(`CHARACTERS\n${lines.join('\n')}`);
  }
  if (memory.relationships?.length) {
    const lines = memory.relationships.slice(0, 10).map(r => `- ${r.from} → ${r.to}: ${r.relation}${r.description ? ` (${trim(r.description, 100)})` : ''}`);
    sections.push(`RELATIONSHIPS\n${lines.join('\n')}`);
  }
  if (memory.settingRules?.length) {
    sections.push(`WORLD RULES\n${memory.settingRules.slice(0, 8).map(r => `- ${trim(r, 160)}`).join('\n')}`);
  }
  if (memory.timeline?.length) {
    const lines = memory.timeline.slice(-8).map(t => `- ${t.when ? `${t.when}: ` : ''}${trim(t.label || t.description, 140)}`);
    sections.push(`TIMELINE (recent)\n${lines.join('\n')}`);
  }
  if (memory.majorEvents?.length) {
    sections.push(`ESTABLISHED EVENTS\n${memory.majorEvents.slice(-10).map(e => `- ${trim(e, 160)}`).join('\n')}`);
  }
  if (memory.openThreads?.length) {
    sections.push(`UNRESOLVED THREADS\n${memory.openThreads.slice(0, 8).map(t => `- ${trim(t, 160)}`).join('\n')}`);
  }
  if (memory.previousSummaries?.length) {
    const summaries = memory.previousSummaries.slice(-maxSummaries);
    sections.push(`RECENT CHAPTERS (summaries only)\n${summaries.map((s, i) => `${i + 1}. ${trim(s, 500)}`).join('\n')}`);
  }
  if (memory.continuityConstraints?.length) {
    sections.push(`CONTINUITY CONSTRAINTS\n${memory.continuityConstraints.slice(0, 8).map(c => `- ${trim(c, 160)}`).join('\n')}`);
  }
  if (memory.styleNotes?.length) {
    sections.push(`STYLE\n${memory.styleNotes.slice(0, 6).map(s => `- ${trim(s, 160)}`).join('\n')}`);
  }

  const block = sections.join('\n\n');
  return block.length > maxChars ? `${block.slice(0, maxChars)}…` : block;
}

function normaliseCharacters(characters: CoverPromptInput['characters']): string {
  if (!characters) return '';
  if (typeof characters === 'string') return trim(characters, 200);
  return characters
    .slice(0, 3)
    .map(c => [c.name, c.role, c.appearance].filter(Boolean).join(' — '))
    .map(s => trim(s, 140))
    .join('; ');
}

function trim(value: string | null | undefined, max: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
