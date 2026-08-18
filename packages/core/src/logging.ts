import { createHash } from 'node:crypto';

/**
 * Field names that carry protected health information or direct identifiers.
 *
 * HIPAA's audit-control requirement pushes us to log a great deal about *what* the sync
 * did, while the minimum-necessary standard forbids logging *who* it was about. Cloud
 * Logging is not a PHI-cleared store in most deployments, and log sinks fan out to places
 * nobody audits. So redaction is applied centrally on the way out rather than left to the
 * discipline of whoever writes the next log line.
 *
 * Matching is case-insensitive and substring-based on purpose: `patientFirstName`,
 * `subscriber_last_name` and `guarantorPhone` all have to be caught without maintaining an
 * exhaustive list. Over-redacting a log field is a cosmetic problem; under-redacting is a
 * reportable breach.
 */
const PHI_KEY_FRAGMENTS = [
  'name',
  'birth',
  'dob',
  'ssn',
  'socialsecurity',
  'mrn',
  'medicalrecord',
  'address',
  'street',
  'city',
  'zip',
  'postal',
  'phone',
  'fax',
  'email',
  'photo',
  'policynumber',
  'memberid',
  'subscriber',
  'guarantor',
  'diagnos',
  'note',
  'comment',
  'reason',
] as const;

/**
 * Exact key names this codebase uses for its own closed enums, exempted from the substring rule.
 *
 * `reason` is on the denylist because in a healthcare payload it is usually free text — reason for
 * visit, reason for admission — and that is clinical narrative. But it is also the natural name for
 * the sync's own decision enums, and blanking `reason: "withdrawnUpstream"` removes exactly the
 * field an operator needs to understand why a coverage row closed.
 *
 * Exact matching is what makes the exemption narrow enough to be safe: `reasonForVisit`,
 * `admissionReason` and `noteReason` are all still redacted, and nothing in this system logs a raw
 * upstream payload — the transport logs the route template, never the response body.
 */
const SAFE_EXACT_KEYS = new Set([
  'reason',
  'skipReason',
  'closureReason',
  'failureReason',
  'driftReason',
]);

const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

function isPhiKey(key: string): boolean {
  if (SAFE_EXACT_KEYS.has(key)) return false;
  const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
  return PHI_KEY_FRAGMENTS.some((fragment) => normalised.includes(fragment));
}

/**
 * Correlating log lines about the same patient without writing the identifier down.
 * Truncated to 12 hex characters: enough to correlate within a tenant, short enough that
 * it is useless as a lookup key if the logs leak.
 */
export function pseudonymise(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function redact(input: unknown, depth = 0): unknown {
  if (input === null || input === undefined) return input;
  if (depth >= MAX_DEPTH) return '[truncated]';

  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }

  if (input instanceof Date) return input.toISOString();

  if (input instanceof Error) {
    return { name: input.name, message: input.message, stack: input.stack };
  }

  if (Array.isArray(input)) {
    return input.slice(0, 50).map((item) => redact(item, depth + 1));
  }

  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      result[key] = isPhiKey(key) ? REDACTED : redact(value, depth + 1);
    }
    return result;
  }

  return `[unloggable:${typeof input}]`;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  severity: Uppercase<LogLevel>;
  message: string;
  timestamp: string;
  service: string;
  /** PCC message id or task id, so one causal chain can be pulled out of a busy log. */
  correlationId?: string;
  therapyOrgId?: string;
  facilityId?: string;
  [key: string]: unknown;
};

export type LogSink = (entry: LogEntry) => void;

/** Single-line JSON is what Cloud Logging parses into structured fields. */
export const jsonSink: LogSink = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

export type LoggerContext = {
  service: string;
  correlationId?: string;
  therapyOrgId?: string;
  facilityId?: string;
};

export type Logger = {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Derives a child logger that carries additional correlation fields. */
  child(context: Partial<LoggerContext>): Logger;
};

export function createLogger(base: LoggerContext, sink: LogSink = jsonSink): Logger {
  const emit = (level: LogLevel, message: string, context?: Record<string, unknown>): void => {
    const entry: LogEntry = {
      severity: level.toUpperCase() as Uppercase<LogLevel>,
      message,
      timestamp: new Date().toISOString(),
      ...base,
      ...(context ? (redact(context) as Record<string, unknown>) : {}),
    };
    sink(entry);
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
    child: (context) => createLogger({ ...base, ...context }, sink),
  };
}

/** Collects entries in memory so tests can assert on them, including on what was redacted. */
export function createMemorySink(): { sink: LogSink; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { sink: (entry) => entries.push(entry), entries };
}
