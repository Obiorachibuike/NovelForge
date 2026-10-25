import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { consumeEmailVerification } from '@/services/auth/email-actions';
const schema=z.object({token:z.string().min(20).max(200)});
export const POST=apiHandler(async(req:Request)=>{const body=await readJsonBody(req,v=>schema.parse(v),MAX_JSON_BYTES.default);if(!await consumeEmailVerification(body.token))throw new HttpError(400,'This verification link is invalid, expired, or already used.','invalid_verification_token');return Response.json({ok:true});});
