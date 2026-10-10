import type { NovelRow, NovelSettingsRow } from '@/types';

export interface NovelContext {
  novel: NovelRow;
  settings?: NovelSettingsRow;
  premise?: { logline?: string|null; shortSynopsis?: string|null; fullSynopsis?: string|null; themes?: string|null; setting?: string|null; majorConflicts?: string|null };
  characters?: Array<{ name:string; role:string; arc?: string|null; personality?: string|null }>;
  previousSummary?: string;
  memories?: Array<{ content:string; kind:string }>;
}

export function buildSystemPrompt(role: string): string {
  return `You are a senior fiction editor and collaborator working inside NovelForge, a novel-writing studio.
Your task: ${role}.
You will never expose the fact that you are an AI inside the story itself.
You will honour the writer's tone, POV, audience, and target word counts.
You will produce concrete, specific, vivid prose rather than vague platitudes.
You will not recap the instructions in your output.`;
}

export function premisePrompt(novel: NovelRow) {
  return {
    system: buildSystemPrompt('Generate a novel premise package from a title and genre.'),
    user: `Create a premise package for a new novel.

Title: ${novel.title}
Genre: ${novel.genre}
${novel.premise ? `Author's seed idea: ${novel.premise}` : ''}
POV: ${novel.pov}
${novel.tone ? `Tone: ${novel.tone}` : ''}
${novel.style ? `Style: ${novel.style}` : ''}
${novel.audience ? `Audience: ${novel.audience}` : ''}
Target: ~${novel.targetWords.toLocaleString()} words, ~${novel.targetChapters} chapters.

Return a JSON object with the following fields:
- logline: one sentence (25 words or fewer)
- shortSynopsis: one paragraph (80-140 words)
- fullSynopsis: three paragraphs describing the setup, central conflict, and climactic stakes WITHOUT spoiling every beat
- themes: array of 3-5 thematic ideas (single phrases)
- setting: a paragraph describing time, place, atmosphere
- majorConflicts: array of 3-5 strings describing the primary conflicts
- mainCharacters: array of 3-5 objects, each with { name, role, age, personality, motivation, goal, fear, arc }
- supportingCharacters: array of 2-4 objects with same shape
- worldRules: array of 2-6 objects with { name, description, category }
- timelineFoundation: array of 4-6 objects with { label, description, when, orderIndex }
- majorConflicts are listed above as well.
`,
  };
}

export function outlinePrompt(ctx: NovelContext, structureType: string) {
  return {
    system: buildSystemPrompt('Generate a complete chapter-by-chapter outline.'),
    user: `Using the novel premise and story bible below, generate a complete ${structureType} chapter outline.

Novel: ${ctx.novel.title}
Genre: ${ctx.novel.genre}
Target chapters: ${ctx.novel.targetChapters}
Target words: ${ctx.novel.targetWords.toLocaleString()} (average ~${Math.round(ctx.novel.targetWords/Math.max(1,ctx.novel.targetChapters)).toLocaleString()} per chapter)
POV: ${ctx.novel.pov}
${ctx.novel.tone ? `Tone: ${ctx.novel.tone}` : ''}
Logline: ${ctx.premise?.logline || ''}
Short synopsis: ${ctx.premise?.shortSynopsis || ''}
Main characters: ${(ctx.characters||[]).map(c => `${c.name} (${c.role})`).join(', ')}

Return a JSON object with:
- acts: array of { actNumber, name, description, purpose, turningPoint, orderIndex }
- chapters: array of chapter objects, one per planned chapter, each with {
    chapterNumber, title, summary, narrativePurpose,
    majorEvents: string[], charactersInvolved: string[],
    location, conflict, emotionalObjective, plotAdvancement, foreshadowing,
    targetWords, estimatedPages
  }
Target words across all chapters must sum to approximately ${ctx.novel.targetWords}.
Allocate higher word counts to climactic chapters and lower to early transitions.
estimatedPages = Math.round(targetWords / 320).
Chapters must be ordered by chapterNumber starting at 1.`,
  };
}

export function chapterPrompt(ctx: NovelContext, chapter: { number:number; title:string; summary?:string|null; targetWords:number; charactersInvolved?:string|null; location?:string|null; conflict?:string|null; }, previousSummary?: string) {
  const memories = (ctx.memories || []).map(m => `- [${m.kind}] ${m.content}`).join('\n');
  return {
    system: buildSystemPrompt(`Write chapter ${chapter.number} of a novel. Write literary, immersive prose. Stay in POV. Do not summarise; dramatize scene by scene. Use dialogue, sensory detail, and interiority. Write to approximately ${chapter.targetWords} words. End the chapter with a new question or hook, not a tidy resolution. Never write meta-commentary. Never explain your choices.`),
    user: `Novel: ${ctx.novel.title}
${ctx.novel.tone ? `Tone: ${ctx.novel.tone}` : ''}
POV: ${ctx.novel.pov}
Location: ${chapter.location || 'unspecified'}
Conflict: ${chapter.conflict || ''}
Chapter title: ${chapter.title}
Chapter summary (from outline): ${chapter.summary || ''}
Characters present: ${chapter.charactersInvolved || ''}

${previousSummary ? `Previous chapter summary:\n${previousSummary}\n\n` : ''}
${memories ? `Relevant story memories (stay consistent with these):\n${memories}\n\n` : ''}
Begin writing Chapter ${chapter.number}, "${chapter.title}". Write the chapter as prose only.`,
  };
}

export function chapterSummaryPrompt(novel: NovelRow, chapter: { number:number; title:string }, text: string) {
  return {
    system: buildSystemPrompt('Extract a concise summary, important events, and character-state changes from a chapter.'),
    user: `Summarise this chapter from "${novel.title}" (Chapter ${chapter.number}: ${chapter.title}).

Return a JSON object with keys:
- summary: 3-6 sentence recap
- importantEvents: string[] (5-10 concrete events that happen)
- characterUpdates: array of { name, newState: string } (state changes, new knowledge, wounds, relationships shifted)
- timelineUpdates: array of { label, description, when }
- plotThreadUpdates: array of { title, description, status } (status is one of open|progressing|resolved|new)
- worldRuleUpdates: array of { name, description, category } (only if new rules are introduced)
- foreshadowedPayoffs: string[] (newly planted seeds)

Chapter text:
${text.slice(0, 12000)}`,
  };
}

export function consistencyCheckPrompt(novel: NovelRow, chapter: { number:number; title:string }, text: string, bible: string) {
  return {
    system: buildSystemPrompt('Identify continuity and consistency problems in a chapter against the story bible.'),
    user: `You are the novel's continuity editor. Check this chapter against the Story Bible. Return a JSON array of issues. Each issue has:
- kind: one of timeline | character | location | world | thread | relationship
- severity: info | warning | error
- title: short title
- description: what's wrong (1-2 sentences)
- evidence: short quote or reference
- suggestion: concrete fix

Return [] if nothing is wrong.

Story Bible:
${bible.slice(0, 12000)}

Chapter text:
${text.slice(0, 10000)}`,
  };
}

export function editorActionPrompt(action: string, opts: { selection?: string; before?: string; after?: string; title: string; }) {
  const actionDesc: Record<string, string> = {
    continue: 'Continue the scene naturally from the cursor. Match the existing voice and pacing.',
    rewrite: 'Rewrite the selected passage to be sharper and more vivid while keeping every story beat.',
    expand: 'Expand the selected passage with more sensory detail and interiority without adding plot.',
    shorten: 'Tighten the selected passage, removing redundancy while keeping the scene intact.',
    improve: 'Improve the prose quality, fix any awkward phrasing, and sharpen imagery.',
    dialogue: 'Rewrite the dialogue in the selected passage to sound more natural and character-specific.',
    tone: 'Adjust the tone of the selected passage to deepen emotional resonance.',
    continuity: 'Flag any continuity issue in the selection relative to immediate context and fix it.',
    'alt-scene': 'Write an alternative version of the scene in the same voice.',
  };
  return {
    system: buildSystemPrompt('Act as an in-editor writing assistant. Return only the replacement / continuation text. Do not wrap in quotes, add commentary, or summarise.'),
    user: `${actionDesc[action] || 'Continue writing.'}
Chapter title: ${opts.title}
${opts.selection ? `Selection:\n${opts.selection}\n\nReturn the revised/continued text only.` : 'Continue from the end of context provided.'}
${opts.before ? `Before:\n${opts.before.slice(-500)}\n\n` : ''}${opts.after ? `After:\n${opts.after.slice(0,500)}\n\n` : ''}`,
  };
}

export function coverPrompt(novel: NovelRow, style = 'cinematic hardcover') {
  return `Design a portrait-oriented book cover for a novel titled "${novel.title}" in the ${novel.genre} genre. ${novel.premise ? `Concept: ${novel.premise}.` : ''} ${novel.tone ? `Tone: ${novel.tone}.` : ''} Style: ${style}. Negative space for title and author name at the top and bottom. Dramatic lighting, premium printed-book feel, no fake text other than a subtle title suggestion.`;
}
