import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';
import bcrypt from 'bcryptjs';
import { getDb } from '@/lib/db';
import { normalizeEmail, BCRYPT_ROUNDS } from './service';

export type AuthAction='verify-email'|'reset-password';
const TOKEN_TTL_MS=60*60*1000;
const digest=(token:string)=>createHash('sha256').update(token).digest('hex');
function appUrl(){return (process.env.NEXT_PUBLIC_APP_URL||process.env.NEXTAUTH_URL||'http://localhost:3000').replace(/\/$/,'');}
async function deliver(to:string,subject:string,url:string){
  const key=process.env.RESEND_API_KEY, from=process.env.MAIL_FROM;
  if(!key||!from){
    if(process.env.NODE_ENV!=='production'){
      // Development fallback: sign-in requires a verified email, so without an
      // email provider a freshly registered account could never sign in. Emit
      // the one-time link to the server console instead. Never in production:
      // there the operator must configure a real provider.
      console.log(`[auth] Email delivery is not configured (RESEND_API_KEY/MAIL_FROM). Development fallback — ${subject} link for ${to}: ${url}`);
      return;
    }
    throw new Error('Email delivery is not configured. Set RESEND_API_KEY and MAIL_FROM.');
  }
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to,subject,html:`<p>Use the secure link below. It expires in 1 hour and can be used once.</p><p><a href="${url}">${subject}</a></p><p>If you did not request this, you can ignore this message.</p>`})});
  if(!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
}
export async function createAndSendAuthAction(emailRaw:string,purpose:AuthAction){
  const email=normalizeEmail(emailRaw), db=getDb();
  const user=db.prepare('SELECT id FROM users WHERE email=?').get(email) as {id:string}|undefined;
  if(!user)return false;
  if(purpose==='verify-email'){
    const row=db.prepare('SELECT emailVerified FROM users WHERE id=?').get(user.id) as any;
    if(row?.emailVerified)return false;
  }
  const raw=randomBytes(32).toString('base64url'), now=new Date(), expiry=new Date(now.getTime()+TOKEN_TTL_MS).toISOString();
  db.prepare('DELETE FROM auth_action_tokens WHERE email=? AND purpose=?').run(email,purpose);
  db.prepare('INSERT INTO auth_action_tokens (id,userId,email,purpose,tokenHash,expiresAt,createdAt) VALUES (?,?,?,?,?,?,?)').run(nanoid(),user.id,email,purpose,digest(raw),expiry,now.toISOString());
  const page=purpose==='verify-email'?'verify-email':'reset-password';
  const url=`${appUrl()}/${page}?token=${encodeURIComponent(raw)}`;
  await deliver(email,purpose==='verify-email'?'Verify your NovelForge email':'Reset your NovelForge password',url);
  return true;
}
export async function consumeEmailVerification(raw:string){
  if(!raw||raw.length>200)return false;
  const db=getDb(),now=new Date().toISOString();
  const token=db.prepare('SELECT id,userId,email FROM auth_action_tokens WHERE tokenHash=? AND purpose=? AND consumedAt IS NULL AND expiresAt>?').get(digest(raw),'verify-email',now) as any;
  if(!token)return false;
  const tx=db.transaction(()=>{db.prepare('UPDATE users SET emailVerified=?,updatedAt=? WHERE id=? AND email=?').run(now,now,token.userId,token.email);db.prepare('UPDATE auth_action_tokens SET consumedAt=? WHERE id=? AND consumedAt IS NULL').run(now,token.id);});
  tx(); return true;
}
export async function consumePasswordReset(raw:string,password:string){
  if(!raw||raw.length>200||password.length<8||password.length>72)return false;
  const db=getDb(),now=new Date().toISOString();
  const token=db.prepare('SELECT id,userId FROM auth_action_tokens WHERE tokenHash=? AND purpose=? AND consumedAt IS NULL AND expiresAt>?').get(digest(raw),'reset-password',now) as any;
  if(!token)return false;
  const hash=await bcrypt.hash(password,BCRYPT_ROUNDS);
  const tx=db.transaction(()=>{const result=db.prepare('UPDATE auth_action_tokens SET consumedAt=? WHERE id=? AND consumedAt IS NULL').run(now,token.id);if(!result.changes)return false;db.prepare('UPDATE users SET passwordHash=?,updatedAt=? WHERE id=?').run(hash,now,token.userId);return true;});
  return tx();
}
