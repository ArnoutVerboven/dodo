import { PROMPTS, type PromptGroup, type PromptInfo } from '@dodo/core';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';

const GROUPS: PromptGroup[] = ['Task agent', 'Conversation', 'Routing', 'Email jobs'];

/**
 * Read-only view of every prompt dodo sends to a model, straight from @dodo/core's prompts
 * module, so what you read here is what the models get.
 */
export function PromptsSettings() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Everything dodo tells a model, as it is in this build. Parts filled in at run time show as{' '}
        <code className="rounded bg-muted px-1">{'{placeholders}'}</code>. Tool descriptions are in{' '}
        <Link to="/tools?tab=builtin" className="text-foreground underline underline-offset-2">
          Tools
        </Link>
        .
      </p>
      {GROUPS.map((group) => (
        <Card key={group}>
          <CardHeader title={group} />
          <CardBody className="divide-y p-0">
            {PROMPTS.filter((p) => p.group === group).map((p) => (
              <PromptRow key={p.id} prompt={p} />
            ))}
          </CardBody>
        </Card>
      ))}
    </div>
  );
}

function PromptRow({ prompt }: { prompt: PromptInfo }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(prompt.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="px-4 py-3 text-sm">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-start gap-2 text-left"
      >
        <ChevronRight
          className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{prompt.name}</span>
            <Badge className="text-muted-foreground">{prompt.kind}</Badge>
            <span className="text-xs text-muted-foreground">
              {prompt.text.length.toLocaleString()} chars
            </span>
          </span>
          <span className="mt-0.5 block text-muted-foreground">{prompt.purpose}</span>
        </span>
      </button>
      {open && (
        <div className="relative mt-2 ml-6">
          <button
            type="button"
            onClick={copy}
            className="absolute top-2 right-2 rounded-md border bg-background p-1.5 text-muted-foreground hover:bg-accent"
            aria-label="Copy prompt"
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <pre className="max-h-[32rem] overflow-auto rounded-md bg-muted p-3 pr-10 text-xs leading-relaxed whitespace-pre-wrap">
            {prompt.text}
          </pre>
        </div>
      )}
    </div>
  );
}
