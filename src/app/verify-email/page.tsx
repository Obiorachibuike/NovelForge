'use client';
import { useEffect,useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
function Verify(){const params=useSearchParams(),token=params.get('token')||'';const [status,setStatus]=useState('Verifying your email…');useEffect(()=>{if(!token){setStatus('The verification link is invalid.');return;}fetch('/api/auth/verify-email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token})}).then(async r=>{if(!r.ok)throw new Error();setStatus('Email verified. You can now sign in.');}).catch(()=>setStatus('This link is invalid, expired, or already used.'));},[token]);return <main className="min-h-screen bg-[#05070D] flex items-center justify-center p-6 text-white"><section className="max-w-md space-y-5"><h1 className="font-serif text-3xl">Verify your email</h1><p role="status" className="text-slate-300">{status}</p><Link className="text-indigo-400" href="/login">Continue to sign in</Link></section></main>}
export default function VerifyEmailPage(){return <Suspense fallback={<main className="min-h-screen bg-[#05070D] text-white p-8">Loading…</main>}><Verify/></Suspense>}
