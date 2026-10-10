import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { enqueueChapterGeneration, listChapters } from '@/services/chapters/service';
import { chapterGenerateSchema } from '@/types';
import { z } from 'zod';
export async function GET(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const url=new URL(req.url);const n=url.searchParams.get('chapterNumber');let c=await listChapters(params.id);if(n)c=c.filter(x=>x.chapterNumber===parseInt(n,10));return NextResponse.json(c);}catch(e){return jsonError(NextResponse,e);}}
export async function POST(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);chapterGenerateSchema.parse(await req.json().catch(()=>({})));const db=(await import('@/lib/db')).getDb();const r=db.prepare("SELECT COALESCE(MAX(chapterNumber),0)+1 AS next FROM chapters WHERE novelId=? AND status='approved'").get(params.id);const n=(r && r.next)?r.next:1;return NextResponse.json({jobId:await enqueueChapterGeneration(u.id,params.id,n),chapterNumber:n});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
