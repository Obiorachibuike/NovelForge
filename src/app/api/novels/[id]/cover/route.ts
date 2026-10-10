import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { generateCovers, listCovers } from '@/services/images/service';
import { setCover } from '@/services/novels/service';
import { coverGenerateSchema, coverSelectSchema } from '@/types';
import { z } from 'zod';
export async function GET(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);return NextResponse.json(listCovers(params.id));}catch(e){return jsonError(NextResponse,e);}}
export async function POST(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const b=coverGenerateSchema.parse(await req.json().catch(()=>({})));const c=await generateCovers(u.id,params.id,b.prompt,b.variants);return NextResponse.json(c);}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
export async function PUT(req,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);const{imageId}=coverSelectSchema.parse(await req.json());await setCover(params.id,u.id,imageId);return NextResponse.json({ok:true});}catch(e){if(e instanceof z.ZodError)return NextResponse.json({error:e.errors[0].message},{status:400});return jsonError(NextResponse,e);}}
