/**
 * Single source of truth for the sequential-writing gate.
 *
 * Pure and dependency-free so the server (`getNavigation`) and the outline
 * editor client component cannot drift apart: a chapter N can only be written
 * once every chapter before it is approved.
 */
export interface OutlineLike {
  chapterNumber: number;
  title?: string | null;
  summary?: string | null;
  targetWords?: number | null;
  estimatedPages?: number | null;
}

export interface ChapterLike {
  id: string;
  chapterNumber: number;
  status: string;
  title?: string | null;
  wordCount?: number | null;
  pageCountEst?: number | null;
  generationSource?: string | null;
}

export type ChapterNavStatus = 'locked' | 'next' | 'planned' | 'draft' | 'generated' | 'edited' | 'approved';

export interface ChapterNav {
  chapterNumber: number;
  title: string;
  summary: string | null;
  targetWords: number;
  targetPages: number;
  status: ChapterNavStatus;
  chapterId: string | null;
  wordCount: number;
  pageCountEst: number;
  generationSource: string | null;
}

export function computeNavigation(outlines: OutlineLike[], chapters: ChapterLike[]): ChapterNav[] {
  const byNumber = new Map<number, ChapterLike>();
  for (const c of chapters) byNumber.set(c.chapterNumber, c);
  const ordered = [...outlines].sort((a, b) => a.chapterNumber - b.chapterNumber);

  let previousApproved = true;
  return ordered.map(o => {
    const chapter = byNumber.get(o.chapterNumber);
    let status: ChapterNavStatus;
    if (!previousApproved) status = 'locked';
    else if (chapter) status = normalizeStatus(chapter.status);
    else status = 'next';

    previousApproved = previousApproved && chapter?.status === 'approved';

    const targetWords = o.targetWords ?? 0;
    return {
      chapterNumber: o.chapterNumber,
      title: chapter?.title || o.title || `Chapter ${o.chapterNumber}`,
      summary: o.summary ?? null,
      targetWords,
      targetPages: o.estimatedPages ?? Math.max(1, Math.round(targetWords / 320)),
      status,
      chapterId: chapter?.id ?? null,
      wordCount: chapter?.wordCount ?? 0,
      pageCountEst: chapter?.pageCountEst ?? 0,
      generationSource: chapter?.generationSource ?? null,
    };
  });
}

function normalizeStatus(status: string): ChapterNavStatus {
  switch (status) {
    case 'approved':
    case 'edited':
    case 'generated':
    case 'draft':
      return status;
    default:
      return 'draft';
  }
}

/** The first chapter that is not yet approved, i.e. the only one generatable now. */
export function nextWritableChapter(nav: ChapterNav[]): number | null {
  const first = nav.find(n => n.status !== 'approved');
  return first ? first.chapterNumber : null;
}
