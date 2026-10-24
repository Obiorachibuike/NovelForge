import { z } from 'zod';
import { apiHandler, readJsonBody, MAX_JSON_BYTES } from '@/lib/api/http';
import { enforceRateLimit, clientIp } from '@/lib/security/rate-limit';
import { createAndSendAuthAction } from '@/services/auth/email-actions';
const schema=z.object({email:z.string().email().max(320)});
export const POST=apiHandler(async(req:Request)=>{enforceRateLimit('authRecovery',clientIp(req));const body=await readJsonBody(req,v=>schema.parse(v),MAX_JSON_BYTES.default);try{await createAndSendAuthAction(body.email,'verify-email');}catch{console.warn('[auth] verification email delivery failed.');}return Response.json({ok:true,message:'If the account needs verification, a link will be sent.'});});
