import { NextResponse } from 'next/server';
import { requireUser, requireNovel, jsonError } from '@/lib/db/ownership';
import { getNovel, deleteNovel } from '@/services/novels/service';
export async function GET(_, { params }) { try { const u = await requireUser(); const n = await getNovel(params.id, u.id); if(!n) return NextResponse.json({error:'Not found'},{status:404}); return NextResponse.json(n); } catch(e){ return jsonError(NextResponse,e); } }
export async function DELETE(_, { params }) { try { const u = await requireUser(); await requireNovel(params.id, u.id); await deleteNovel(params.id, u.id); return NextResponse.json({ok:true}); } catch(e){ return jsonError(NextResponse,e); } }
