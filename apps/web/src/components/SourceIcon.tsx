import type { TaskSource } from '@dodo/core';
import { CalendarDays, ExternalLink, Webhook } from 'lucide-react';
import { cn } from '@/lib/utils';

const LABEL: Record<TaskSource['kind'], string> = {
  gmail: 'Gmail',
  whatsapp: 'WhatsApp',
  calendar: 'Calendar',
  api: 'Task API',
};

function GmailLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75V40h7a3 3 0 0 0 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.61 1.71L13 23.7V40H6a3 3 0 0 1-3-3V16.2z" />
      <path fill="#e53935" d="M35 11.2L24 19.45 13 11.2l-1 5.8 1 6.7 11 8.25 11-8.25 1-6.7z" />
      <path
        fill="#c62828"
        d="M3 12.3v3.9l10 7.5V11.2L9.88 8.86A4.3 4.3 0 0 0 7.3 8 4.3 4.3 0 0 0 3 12.3z"
      />
      <path
        fill="#fbc02d"
        d="M45 12.3v3.9l-10 7.5V11.2l3.12-2.34A4.3 4.3 0 0 1 40.7 8 4.3 4.3 0 0 1 45 12.3z"
      />
    </svg>
  );
}

function WhatsAppLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <path
        fill="#25d366"
        d="M24 4C13 4 4 12.9 4 23.9c0 3.9 1.1 7.5 3.1 10.6L4 44l9.8-3.1c3 1.7 6.5 2.6 10.2 2.6 11 0 20-8.9 20-19.8C44 12.9 35 4 24 4z"
      />
      <path
        fill="#fff"
        d="M33.7 28.6c-.5-.3-3-1.5-3.4-1.6-.5-.2-.8-.3-1.1.2-.3.5-1.3 1.6-1.6 2-.3.3-.6.4-1.1.1-.5-.3-2.1-.8-4-2.5-1.5-1.3-2.5-2.9-2.8-3.4-.3-.5 0-.8.2-1 .2-.2.5-.6.7-.9.2-.3.3-.5.5-.9.2-.3.1-.6 0-.9-.1-.3-1.1-2.7-1.5-3.6-.4-1-.8-.8-1.1-.8h-.9c-.3 0-.9.1-1.3.6-.5.5-1.7 1.7-1.7 4.1s1.8 4.7 2 5c.2.3 3.5 5.4 8.5 7.6 1.2.5 2.1.8 2.8 1 1.2.4 2.3.3 3.1.2.9-.1 3-1.2 3.4-2.4.4-1.2.4-2.2.3-2.4-.1-.2-.4-.3-.9-.6z"
      />
    </svg>
  );
}

/** The logo of where a task came from (a job, the task API). */
export function SourceIcon({
  source,
  className,
}: {
  source: Pick<TaskSource, 'kind'>;
  className?: string;
}) {
  const cls = cn('h-3.5 w-3.5 shrink-0', className);
  const label = `From ${LABEL[source.kind]}`;
  return (
    <span title={label} role="img" aria-label={label} className="inline-flex">
      {source.kind === 'gmail' ? (
        <GmailLogo className={cls} />
      ) : source.kind === 'whatsapp' ? (
        <WhatsAppLogo className={cls} />
      ) : source.kind === 'calendar' ? (
        <CalendarDays className={cn(cls, 'text-blue-600')} />
      ) : (
        <Webhook className={cn(cls, 'text-muted-foreground')} />
      )}
    </span>
  );
}

/** Chip on the task page: the source's logo and a link that opens the original thread. */
export function SourceLink({ source }: { source: TaskSource }) {
  const text = `${source.url ? 'Open in ' : 'From '}${LABEL[source.kind]}${source.label ? ` · ${source.label}` : ''}`;
  const cls =
    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 text-xs font-medium';
  if (!source.url) {
    return (
      <span className={cls}>
        <SourceIcon source={source} />
        <span className="truncate">{text}</span>
      </span>
    );
  }
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(cls, 'transition hover:bg-accent')}
    >
      <SourceIcon source={source} />
      <span className="truncate">{text}</span>
      <ExternalLink className="h-3 w-3 shrink-0 text-muted-foreground" />
    </a>
  );
}
