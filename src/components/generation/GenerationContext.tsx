'use client';

import { createContext, useContext } from 'react';
import type { GenerationView } from '@/lib/hooks/useGenerationStream';

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  message: string;
  novelId?: string | null;
  chapterId?: string | null;
  generationJobId?: string | null;
  isRead: boolean;
  createdAt: string;
  href?: string | null;
}

export interface GenerationContextValue {
  generations: GenerationView[];
  activeGenerations: GenerationView[];
  notifications: NotificationView[];
  unreadCount: number;
  connectedJobIds: string[];
  trackGeneration: (generation: GenerationView) => void;
  refresh: () => Promise<void>;
  cancelGeneration: (jobId: string) => Promise<void>;
  retryGeneration: (jobId: string) => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
}

export const GenerationContext = createContext<GenerationContextValue | null>(null);

export function useGeneration(): GenerationContextValue {
  const ctx = useContext(GenerationContext);
  if (!ctx) throw new Error('useGeneration must be used inside <GenerationProvider>');
  return ctx;
}

/** For components that may be rendered outside the authenticated shell. */
export function useOptionalGeneration(): GenerationContextValue | null {
  return useContext(GenerationContext);
}
