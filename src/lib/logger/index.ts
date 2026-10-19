export type LogLevel = 'info' | 'warn' | 'error';

export type LogCategory =
  | 'db'
  | 'autosave'
  | 'ai_job'
  | 'auth'
  | 'authz'
  | 'export'
  | 'backup'
  | 'system';

const SENSITIVE_KEY_PATTERN = /(password|secret|token|apikey|api_key|authorization|cookie|PlainText|contentJson|contentHtml)/i;

function sanitizeValue(val: unknown): unknown {
  if (typeof val === 'string') {
    return val
      .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-[REDACTED]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
      .replace(/(redis|postgres|postgresql|mysql|https?):\/\/([^:\s/@]+):([^@\s/]+)@/gi, '$1://$2:[REDACTED]@');
  }
  if (Array.isArray(val)) {
    return val.map(sanitizeValue);
  }
  if (val && typeof val === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(v);
      }
    }
    return out;
  }
  return val;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  event: string;
  meta?: Record<string, unknown>;
}

export function formatLogEntry(
  level: LogLevel,
  category: LogCategory,
  event: string,
  meta?: Record<string, unknown>,
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    category,
    event: sanitizeValue(event) as string,
    ...(meta ? { meta: sanitizeValue(meta) as Record<string, unknown> } : {}),
  };
}

export const logger = {
  info(category: LogCategory, event: string, meta?: Record<string, unknown>) {
    const entry = formatLogEntry('info', category, event, meta);
    if (process.env.NODE_ENV !== 'test') {
      console.info(JSON.stringify(entry));
    }
    return entry;
  },
  warn(category: LogCategory, event: string, meta?: Record<string, unknown>) {
    const entry = formatLogEntry('warn', category, event, meta);
    if (process.env.NODE_ENV !== 'test') {
      console.warn(JSON.stringify(entry));
    }
    return entry;
  },
  error(category: LogCategory, event: string, meta?: Record<string, unknown>) {
    const entry = formatLogEntry('error', category, event, meta);
    if (process.env.NODE_ENV !== 'test') {
      console.error(JSON.stringify(entry));
    }
    return entry;
  },
};
