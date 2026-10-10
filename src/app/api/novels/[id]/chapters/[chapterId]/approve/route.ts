import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { approveChapter } from '@/services/chapters/service';
export async function POST(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);await approveChapter(u.id,params.id,params.chapterId);return NextResponse.json({ok:true});}catch(e){return jsonError(NextResponse,e);}}
