import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(d: string|Date|undefined|null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatRelative(d: string|Date|undefined|null): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins===1?'':'s'} ago`;
  const hrs = Math.floor(mins/60);
  if (hrs < 24) return `${hrs} hour${hrs===1?'':'s'} ago`;
  const days = Math.floor(hrs/24);
  if (days < 7) return `${days} day${days===1?'':'s'} ago`;
  return formatDate(date);
}

export function wordsToPages(words: number, wordsPerPage = 320): number {
  return Math.max(1, Math.round(words / wordsPerPage));
}

export function paginateArray<T>(items: T[], page: number, pageSize: number) {
  const start = page * pageSize;
  return items.slice(start, start + pageSize);
}

export async function hashPassword(pw: string) {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(pw, 10);
}

export function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
}

export function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(obj) as (keyof T)[]) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  }
  return out;
}
