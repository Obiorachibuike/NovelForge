import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { requireUser, requireNovel } from '@/lib/db/ownership';
import { humanizePassage } from '@/services/humanization/service';
import { humanizerModels } from '@/services/humanization/registry';

const schema=z.object({novelId:z.string().min(1),text:z.string().min(1).max(30_000),modelId:z.string().optional(),mode:z.enum(['light','natural','deep']).optional(),instructions:z.string().max(800).optional(),context:z.string().max(2500).optional()});
export const GET=apiHandler(async()=>{await requireUser();return Response.json({models:humanizerModels,defaultModel:process.env.HUGGINGFACE_HUMANIZER_MODEL||'gohumanize/gohumanize-open-humanizer'});});
export const POST=apiHandler(async(req:Request)=>{const user=await requireUser();const body=await readJsonBody(req,v=>schema.parse(v),MAX_JSON_BYTES.document);await requireNovel(body.novelId,user.id);try{return Response.json(await humanizePassage({text:body.text,modelId:body.modelId,mode:body.mode,instructions:body.instructions,context:body.context}));}catch(err){const message=err instanceof Error?err.message:'Humanization failed';throw new HttpError(message.includes('HF_TOKEN')?503:502,message,'humanization_failed');}});
