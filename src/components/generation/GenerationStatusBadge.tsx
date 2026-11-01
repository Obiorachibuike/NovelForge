'use client';

import { cn } from '@/lib/utils/cn';

export function generationStatusLabel(status?: string | null): string {
  switch (status) {
    case 'QUEUED':
      return 'QUEUED';
    case 'PROCESSING':
      return 'IN PROGRESS';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      return 'NOT STARTED';
  }
}

export function GenerationStatusBadge({
  status,
  className,
  showNotStarted = true,
}: {
  status?: string | null;
  className?: string;
  showNotStarted?: boolean;
}) {
  if (!status && !showNotStarted) return null;
  const tone =
    status === 'COMPLETED'
      ? 'chip-success'
      : status === 'FAILED'
        ? 'chip bg-destructive/15 text-destructive border border-destructive/30'
        : status === 'QUEUED' || status === 'PROCESSING'
          ? 'chip-primary'
          : status === 'CANCELLED'
            ? 'chip-muted'
            : 'chip-muted';
  return (
    <span
      className={cn('chip text-[9px] tracking-wider whitespace-nowrap', tone, className)}
      data-generation-status={status || 'NOT_STARTED'}
    >
      {(status === 'QUEUED' || status === 'PROCESSING') && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse mr-1 inline-block" />
      )}
      {generationStatusLabel(status)}
    </span>
  );
}
