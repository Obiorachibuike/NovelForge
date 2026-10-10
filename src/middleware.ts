import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth } from '@/lib/auth/config';
const PUBLIC_ONLY = new Set(['/login','/register']);
const PROTECTED_PREFIXES = ['/dashboard','/novels','/settings','/api/novels','/api/jobs'];
export default auth((req) => {
  const { nextUrl } = req;
  const session = req.auth;
  const isLoggedIn = !!session?.user;
  const pathname = nextUrl.pathname;
  const isProtected = PROTECTED_PREFIXES.some(p => pathname === p || pathname.startsWith(p + '/'));
  const isPublicOnly = PUBLIC_ONLY.has(pathname);
  if (isProtected && !isLoggedIn) {
    const url = new URL('/login', nextUrl.origin);
    url.searchParams.set('callbackUrl', pathname + nextUrl.search);
    return NextResponse.redirect(url);
  }
  if (isPublicOnly && isLoggedIn) {
    return NextResponse.redirect(new URL('/dashboard', nextUrl.origin));
  }
  return NextResponse.next();
});
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|woff2?)$).*)'],
};
