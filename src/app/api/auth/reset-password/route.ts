import { z } from 'zod';
import { apiHandler, readJsonBody, HttpError, MAX_JSON_BYTES } from '@/lib/api/http';
import { consumePasswordReset } from '@/services/auth/email-actions';
const schema=z.object({token:z.string().min(20).max(200),password:z.string().min(8).max(72)});
export const POST=apiHandler(async(req:Request)=>{const body=await readJsonBody(req,v=>schema.parse(v),MAX_JSON_BYTES.default);if(!await consumePasswordReset(body.token,body.password))throw new HttpError(400,'This reset link is invalid, expired, or already used.','invalid_reset_token');return Response.json({ok:true});});
