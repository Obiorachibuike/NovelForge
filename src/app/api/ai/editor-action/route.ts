import { NextResponse } from 'next/server';
import { requireUser, jsonError } from '@/lib/db/ownership';
import { getDb } from '@/lib/db';
import { generateText } from '@/lib/ai/text-generation';
import { editorActionPrompt } from '@/lib/ai/prompts';
import { editorActionSchema } from '@/types';
import { z } from 'zod';

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = editorActionSchema.parse(await req.json());
    const db = getDb();
    const chapter = db.prepare(`SELECT c.*, n.title AS novelTitle, n.tone, n.pov, n.genre FROM chapters c JOIN novels n ON n.id=c.novelId WHERE c.id=?`).get(body.chapterId) as any;
    if (!chapter || chapter.userId !== undefined) {
      // Verify ownership
      const owned = db.prepare(`SELECT 1 FROM novels n JOIN chapters c ON c.novelId=n.id WHERE c.id=? AND n.userId=?`).get(body.chapterId, user.id);
      if (!owned) return NextResponse.json({error:'Not found'}, {status:404});
    }
    const prompt = editorActionPrompt(body.action, {
      selection: body.selection || '', before: body.before, after: body.after, title: chapter.title,
    });
    const text = await generateText({
      messages: [{ role:'system', content: prompt.system }, { role:'user', content: prompt.user }],
      temperature: 0.7, maxTokens: 1500, userId: user.id, novelId: chapter.novelId, taskType: `editor:${body.action}`,
    });
    return NextResponse.json({ text: text.trim() });
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({error:e.errors[0].message},{status:400});
    return jsonError(NextResponse, e);
  }
}
