import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { approveOutline } from '@/services/outlines/service';
export async function POST(_,{params}){try{const u=await requireUser();await requireNovel(params.id,u.id);await approveOutline(u.id,params.id);return NextResponse.json({ok:true});}catch(e){return jsonError(NextResponse,e);}}
