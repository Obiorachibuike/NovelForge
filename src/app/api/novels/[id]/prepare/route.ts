import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { enqueuePrepareNovel } from '@/services/preparation/service';
export async function POST(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);return NextResponse.json({jobId:await enqueuePrepareNovel(u.id,params.id)});}catch(e){return jsonError(NextResponse,e);}}
