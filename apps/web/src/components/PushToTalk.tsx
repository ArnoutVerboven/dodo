import { Loader2, Mic, Square } from 'lucide-react';
import { formatElapsed, usePushToTalk } from '@/lib/speech';
import { cn } from '@/lib/utils';

/**
 * The microphone button for push-to-talk: hold to talk and release, or tap to start and tap to
 * stop. The transcript goes to `onText`. `compact` is the icon-only button for the reply box;
 * otherwise it carries a label. Hidden where the browser cannot record.
 */
export function PushToTalkButton({
  onText,
  compact = false,
  className,
}: {
  onText: (text: string) => void;
  compact?: boolean;
  className?: string;
}) {
  const ptt = usePushToTalk(onText);
  if (!ptt.supported) return null;
  const recording = ptt.state === 'recording';
  const busy = ptt.state === 'starting' || ptt.state === 'transcribing';
  const status = recording
    ? `${formatElapsed(ptt.elapsed)} · ${ptt.mode === 'toggle' ? 'tap to stop' : 'release to stop'}`
    : ptt.state === 'transcribing'
      ? 'Transcribing…'
      : ptt.state === 'starting'
        ? 'Starting mic…'
        : null;
  const hint = 'Hold to talk, or tap to start and tap again to stop';

  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        type="button"
        {...ptt.buttonProps}
        aria-label={recording ? 'Stop recording' : 'Dictate'}
        aria-pressed={recording}
        title={hint}
        disabled={ptt.state === 'transcribing'}
        className={cn(
          'inline-flex shrink-0 touch-none select-none items-center justify-center gap-1.5 rounded-md text-xs transition [-webkit-touch-callout:none] [-webkit-user-select:none] disabled:opacity-60',
          // Compact sits inside a reply box, so it has no border of its own.
          compact ? 'h-8 w-8' : 'h-8 border px-2.5',
          recording
            ? 'animate-pulse border-danger bg-danger text-white'
            : cn(
                'text-muted-foreground hover:bg-accent hover:text-foreground',
                !compact && 'bg-card',
              ),
        )}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : recording && ptt.mode === 'toggle' ? (
          <Square className="h-3.5 w-3.5 fill-current" />
        ) : (
          <Mic className="h-4 w-4" />
        )}
        {!compact && <span>{status ?? 'Hold to talk'}</span>}
      </button>
      {(compact ? (status ?? ptt.error) : ptt.error) && (
        <span
          role="status"
          className={cn(
            'pointer-events-none absolute bottom-full right-0 z-10 mb-1.5 whitespace-nowrap rounded-md border bg-card px-2 py-1 text-xs shadow-sm',
            ptt.error && !status ? 'max-w-64 whitespace-normal text-danger' : 'text-foreground',
          )}
        >
          {compact ? (status ?? ptt.error) : ptt.error}
        </span>
      )}
    </span>
  );
}
