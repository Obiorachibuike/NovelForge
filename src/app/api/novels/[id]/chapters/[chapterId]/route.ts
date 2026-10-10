import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { saveChapterContent, getChapter, listVersions } from '@/services/chapters/service';
import { z } from 'zod';
const saveSchema=z.object({contentJson:z.object({type:z.literal('doc'),content:z.array(z.any())})});
export async function GET(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const c=await getChapter(params.id,params.chapterId);if(!c)return NextResponse.json({error:'Not found'},{status:404});return NextResponse.json({...c,versions:await listVersions(params.chapterId)});}catch(e){return jsonError(NextResponse,e);}}
export async function PATCH(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const b=saveSchema.parse(await req.json());const r=await saveChapterContent(u.id,params.id,params.chapterId,b.contentJson);return NextResponse.json({ok:true,...r});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
