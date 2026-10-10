import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { enqueueExport } from '@/services/exports/service';
import { exportSchema } from '@/types';
import { z } from 'zod';
export async function POST(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const b=exportSchema.parse(await req.json().catch(()=>({})));return NextResponse.json({jobId:await enqueueExport(u.id,params.id,b.format,b.options)});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
