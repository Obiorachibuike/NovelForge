import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { enqueueConsistencyCheck, resolveIssue } from '@/services/consistency/service';
import { z } from 'zod';
export async function POST(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);return NextResponse.json({jobId:await enqueueConsistencyCheck(u.id,params.id)});}catch(e){return jsonError(NextResponse,e);}}
export async function PATCH(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const b=z.object({issueId:z.string(),status:z.enum(['resolved','ignored'])}).parse(await req.json());await resolveIssue(u.id,params.id,b.issueId,b.status);return NextResponse.json({ok:true});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
