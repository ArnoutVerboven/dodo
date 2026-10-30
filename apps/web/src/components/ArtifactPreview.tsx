import type { Artifact } from '@dodo/core';
import { Download, ExternalLink, Loader2, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { previewKind, saveBlob } from '@/lib/files';
import { safeHref } from '@/lib/utils';

/** Text shown in the preview is capped so a huge log cannot freeze the page. */
const MAX_PREVIEW_CHARS = 500_000;

/** A file the agent wrote as a note, or one the user uploaded. Links open in a new tab instead. */
export function canPreview(a: Artifact) {
  return a.kind === 'text' || (a.kind === 'file' && !!a.url);
}

/** A note without an extension is Markdown: that is what the agent writes. */
function kindOf(a: Artifact) {
  if (a.kind === 'text') {
    const k = previewKind(a.name);
    return k === 'none' ? 'markdown' : k;
  }
  return previewKind(a.name);
}

export async function downloadArtifact(a: Artifact) {
  if (a.kind === 'text') {
    const k = kindOf(a);
    const name = a.name.includes('.') ? a.name : `${a.name}.md`;
    const type = k === 'markdown' ? 'text/markdown' : 'text/plain';
    saveBlob(new Blob([a.text ?? ''], { type: `${type};charset=utf-8` }), name);
    return;
  }
  if (!a.url) return;
  try {
    const res = await fetch(a.url);
    if (!res.ok) throw new Error(String(res.status));
    saveBlob(await res.blob(), a.name);
  } catch {
    // Without CORS on the bucket (e.g. local dev) the browser can still open the file itself.
    window.open(a.url, '_blank', 'noreferrer');
  }
}

/** Loads a stored file's text; a note already carries its text. */
function useText(a: Artifact | undefined, wanted: boolean) {
  const [state, setState] = useState<{ text?: string; error?: string; loading: boolean }>({
    loading: false,
  });
  const url = a?.kind === 'file' ? a.url : undefined;
  useEffect(() => {
    if (!wanted || !url) return;
    let alive = true;
    setState({ loading: true });
    fetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (alive) setState({ text, loading: false });
      })
      .catch((e: unknown) => {
        if (alive) setState({ error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => {
      alive = false;
    };
  }, [url, wanted]);
  if (a?.kind === 'text') return { text: a.text ?? '', loading: false };
  return state;
}

export function ArtifactPreview({
  artifact,
  onClose,
  onReplace,
}: {
  artifact: Artifact | undefined;
  onClose: () => void;
  onReplace: (a: Artifact) => void;
}) {
  const kind = artifact ? kindOf(artifact) : 'none';
  const isText = kind === 'markdown' || kind === 'text';
  const { text, error, loading } = useText(artifact, isText);
  // Source view is remembered per file, so opening another file starts rendered again.
  const [rawFor, setRawFor] = useState<string>();
  const raw = !!artifact && rawFor === artifact.id;
  const [downloading, setDownloading] = useState(false);

  const shown = text && text.length > MAX_PREVIEW_CHARS ? text.slice(0, MAX_PREVIEW_CHARS) : text;
  return (
    <Dialog
      open={!!artifact}
      onClose={onClose}
      title={artifact?.name ?? ''}
      className="w-[min(960px,calc(100vw-32px))]"
      actions={
        artifact && (
          <>
            {kind === 'markdown' && !error && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setRawFor(raw ? undefined : artifact.id)}
              >
                {raw ? 'Rendered' : 'Source'}
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              title="Replace with a file"
              aria-label="Replace with a file"
              onClick={() => onReplace(artifact)}
            >
              <Upload className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Download"
              aria-label="Download"
              disabled={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  await downloadArtifact(artifact);
                } finally {
                  setDownloading(false);
                }
              }}
            >
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
            </Button>
            {safeHref(artifact.url) && (
              <a
                href={safeHref(artifact.url)}
                target="_blank"
                rel="noreferrer"
                title="Open in a new tab"
                aria-label="Open in a new tab"
                className="inline-flex h-8 w-8 items-center justify-center rounded-md hover:bg-accent"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
            )}
          </>
        )
      }
    >
      {artifact && (
        <div className="max-h-[70vh] overflow-auto">
          {kind === 'image' && artifact.url ? (
            <img src={artifact.url} alt={artifact.name} className="mx-auto max-w-full" />
          ) : kind === 'pdf' && artifact.url ? (
            <iframe src={artifact.url} title={artifact.name} className="h-[68vh] w-full rounded" />
          ) : isText ? (
            loading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            ) : error ? (
              <p className="text-sm text-muted-foreground">
                Couldn't load a preview ({error}). Use Download or open it in a new tab.
              </p>
            ) : (
              <>
                {kind === 'markdown' && !raw ? (
                  <div className="prose-sm text-sm">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown ?? ''}</ReactMarkdown>
                  </div>
                ) : (
                  <pre className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">
                    {shown}
                  </pre>
                )}
                {text && text.length > MAX_PREVIEW_CHARS && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Preview cut short. Download the file to see all of it.
                  </p>
                )}
                {!text && <p className="text-sm text-muted-foreground">This file is empty.</p>}
              </>
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              No preview for this kind of file. Use Download to open it.
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
