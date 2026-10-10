import { NextResponse } from 'next/server';
import { requireUser, jsonError } from '@/lib/db/ownership';
import { createNovel, listNovels } from '@/services/novels/service';
import { createNovelSchema } from '@/types';
import { z } from 'zod';

export async function GET() {
  try {
    const user = await requireUser();
    const novels = await listNovels(user.id);
    return NextResponse.json(novels);
  } catch (e) { return jsonError(NextResponse, e); }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();
    const body = await req.json();
    const data = createNovelSchema.parse(body);
    const novel = await createNovel(user.id, data);
    return NextResponse.json(novel);
  } catch (e) {
    if (e instanceof z.ZodError) return NextResponse.json({ error: e.errors.map(x=>x.message).join('; ') }, { status:400 });
    return jsonError(NextResponse, e);
  }
}
