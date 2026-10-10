import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { enqueueOutline, listOutlines, listActs } from '@/services/outlines/service';
import { outlineSchema } from '@/types';
import { z } from 'zod';
export async function GET(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);return NextResponse.json({acts:listActs(params.id),chapters:listOutlines(params.id)});}catch(e){return jsonError(NextResponse,e);}}
export async function POST(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const b=outlineSchema.parse(await req.json().catch(()=>({})));return NextResponse.json({jobId:await enqueueOutline(u.id,params.id,b.structure)});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
