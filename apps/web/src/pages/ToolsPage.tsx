import {
  BUILTIN_TOOLS,
  type BuiltinGroup,
  type BuiltinTool,
  builtinRef,
  CORE_TOOLS,
  GROUPS,
  isDeviceOnline,
  type McpServer,
  type McpToolInfo,
  mcpRef,
  refMatches,
  type Toolset,
} from '@dodo/core';
import {
  AlertTriangle,
  ChevronRight,
  Cloud,
  KeyRound,
  Laptop,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { AllowedActionsSettings } from '@/components/AllowedActionsSettings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  deleteRemoteServer,
  deleteToolset,
  refreshServer,
  saveRemoteServer,
  saveToolset,
  setBuiltinEnabled,
  setServerEnabled,
  setServerToolEnabled,
  useDevices,
  useMcpServers,
  useProjects,
  useSettings,
  useTasks,
  useToolSettings,
  useToolsets,
} from '@/lib/data';
import { cn, timeAgo } from '@/lib/utils';

const TABS = [
  { key: 'servers', label: 'MCP servers', icon: Server },
  { key: 'builtin', label: 'Built-in', icon: Wrench },
  { key: 'toolsets', label: 'Toolsets', icon: Package },
  { key: 'permissions', label: 'Always allowed', icon: ShieldCheck },
] as const;
type Tab = (typeof TABS)[number]['key'];

/** What the inspect dialog shows, for a built-in or an MCP tool alike. */
interface Inspected {
  name: string;
  source: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolInfo['annotations'];
  rule?: string;
}

/**
 * The Tools view: every tool the agent can get, where it runs, and what it needs. MCP servers
 * (remote, or local on a Mac), built-in tools, toolsets (presets for tasks) and the rules you
 * answered "Allow always".
 */
export function ToolsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get('tab'))?.key ?? 'servers') as Tab;
  const [inspected, setInspected] = useState<Inspected>();
  const { data: servers } = useMcpServers();
  const { data: toolsets } = useToolsets();
  const { data: settings } = useSettings();
  const counts: Partial<Record<Tab, number>> = {
    servers: servers.length,
    builtin: BUILTIN_TOOLS.length,
    toolsets: toolsets.length,
    permissions: settings.allowRules?.length,
  };
  return (
    <div className="max-w-4xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Tools</h1>
        <p className="text-sm text-muted-foreground">
          What the agent can use. A tool turned off here is off for every task; a toolset on a task
          narrows it to the tools you picked.
        </p>
      </div>
      <div className="flex gap-1 overflow-x-auto border-b" role="tablist">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setParams(key === 'servers' ? {} : { tab: key })}
            className={cn(
              '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground',
              tab === key ? 'border-primary text-foreground' : 'border-transparent',
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
            {counts[key] ? (
              <span className="rounded-full bg-muted px-1.5 text-xs">{counts[key]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {tab === 'servers' && <ServersTab servers={servers} onInspect={setInspected} />}
      {tab === 'builtin' && <BuiltinTab onInspect={setInspected} />}
      {tab === 'toolsets' && <ToolsetsTab servers={servers} toolsets={toolsets} />}
      {tab === 'permissions' && <PermissionsTab />}
      <ToolDialog tool={inspected} onClose={() => setInspected(undefined)} />
    </div>
  );
}

/* ------------------------------ servers ------------------------------ */

function ServersTab({
  servers,
  onInspect,
}: {
  servers: McpServer[];
  onInspect: (t: Inspected) => void;
}) {
  const [adding, setAdding] = useState<'remote' | 'local' | McpServer>();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          Remote servers work for every run. Local ones run on your Mac and only reach tasks running
          there.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAdding('local')}>
            <Laptop className="h-3.5 w-3.5" /> Add on a Mac
          </Button>
          <Button size="sm" onClick={() => setAdding('remote')}>
            <Plus className="h-3.5 w-3.5" /> Add remote server
          </Button>
        </div>
      </div>
      {servers.length === 0 && (
        <Card>
          <CardBody className="space-y-1 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground">No MCP servers yet</p>
            <p>
              Add a remote server by its URL (Linear, Notion, your own), or one that runs on your
              Mac, such as Outlook.
            </p>
          </CardBody>
        </Card>
      )}
      {servers.map((s) => (
        <ServerCard key={s.id} server={s} onInspect={onInspect} onEdit={() => setAdding(s)} />
      ))}
      <RemoteServerDialog
        open={adding === 'remote' || typeof adding === 'object'}
        server={typeof adding === 'object' ? adding : undefined}
        onClose={() => setAdding(undefined)}
      />
      <LocalServerDialog open={adding === 'local'} onClose={() => setAdding(undefined)} />
    </div>
  );
}

function ServerCard({
  server: s,
  onInspect,
  onEdit,
}: {
  server: McpServer;
  onInspect: (t: Inspected) => void;
  onEdit: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const { data: devices } = useDevices();
  const mac = s.deviceId ? devices.find((d) => d.id === s.deviceId) : undefined;
  const online = s.runsOn === 'remote' || isDeviceOnline(mac?.lastSeen);
  const tools = s.catalog?.tools ?? [];
  const off = tools.filter((t) => s.disabledTools.includes(t.name)).length;
  // A refresh asked of a Mac is pending until it answers.
  const waiting =
    s.runsOn === 'local' &&
    !!s.refreshRequestedAt &&
    s.refreshRequestedAt > Math.max(s.catalog?.fetchedAt ?? 0, s.error?.at ?? 0);
  const failedLast = !!s.error && s.error.at >= (s.catalog?.fetchedAt ?? 0);

  const refresh = async () => {
    setBusy(true);
    setNote(undefined);
    try {
      const r = await refreshServer(s.id);
      if (r.error) setNote(r.error);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`Remove ${s.name}? Tasks lose its tools.`)) return;
    try {
      await deleteRemoteServer(s.id);
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  return (
    <Card className={cn(!s.enabled && 'opacity-60')}>
      <div className="flex flex-wrap items-start gap-3 p-4">
        <div
          className={cn(
            'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border',
            s.runsOn === 'local' ? 'bg-attention-bg' : 'bg-muted',
          )}
        >
          {s.runsOn === 'local' ? <Laptop className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
        </div>
        <div className="min-w-0 flex-1 basis-56 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{s.name}</span>
            <code className="text-xs text-muted-foreground">{s.slug}</code>
            {s.runsOn === 'local' ? (
              <Badge>
                <Laptop className="h-3 w-3" /> Local · {mac?.name ?? 'unknown Mac'}
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    online ? 'bg-success' : 'bg-muted-foreground',
                  )}
                  title={online ? 'online' : 'offline'}
                />
              </Badge>
            ) : (
              <Badge>
                <Cloud className="h-3 w-3" /> Remote
              </Badge>
            )}
            {s.hasAuth && (
              <Badge>
                <KeyRound className="h-3 w-3" /> Token
              </Badge>
            )}
            {failedLast && s.error?.needsAuth && (
              <Badge className="border-attention bg-attention-bg">
                <AlertTriangle className="h-3 w-3" /> Needs sign-in
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={detail(s)}>
            {detail(s)}
          </p>
          <p className="text-xs text-muted-foreground">
            {s.catalog ? (
              <>
                {tools.length} tools{off ? `, ${off} off` : ''} · updated{' '}
                {timeAgo(s.catalog.fetchedAt)}
                {s.catalog.by.startsWith('mac:') ? ' on the Mac' : ''}
              </>
            ) : (
              'Tools not loaded yet'
            )}
            {waiting &&
              ` · refresh asked ${timeAgo(s.refreshRequestedAt ?? 0)}, waiting for the Mac`}
          </p>
          {failedLast && s.error && (
            <p className="rounded-md bg-attention-bg px-2 py-1 text-xs break-words">
              {s.error.message}
              {s.runsOn === 'local' && s.error.needsAuth && (
                <>
                  {' '}
                  Sign in on the Mac: <code>pnpm dodo mcp test {s.slug}</code>
                </>
              )}
              {s.runsOn === 'remote' &&
                s.error.needsAuth &&
                ' Edit the server to give it a new token.'}
            </p>
          )}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={refresh}
            disabled={busy || waiting || !online}
            title={online ? 'Load the tools again' : 'The Mac is offline'}
            aria-label={`Refresh ${s.name}`}
          >
            {busy || waiting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
          {s.runsOn === 'remote' && (
            <>
              <Button size="icon" variant="ghost" onClick={onEdit} aria-label={`Edit ${s.name}`}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button size="icon" variant="ghost" onClick={remove} aria-label={`Remove ${s.name}`}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          <Switch
            className="ml-1"
            checked={s.enabled}
            onChange={(v) => setServerEnabled(s.id, v)}
            label={`${s.name} on`}
            title={s.enabled ? 'On for the agent' : 'Off for the agent'}
          />
        </div>
      </div>
      {tools.length > 0 && (
        <div className="border-t">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex w-full items-center gap-1 px-4 py-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
            {open ? 'Hide tools' : `Show ${tools.length} tools`}
          </button>
          {open && (
            <ul className="divide-y border-t">
              {tools.map((t) => (
                <ToolRow
                  key={t.name}
                  name={t.name}
                  description={t.description}
                  badge={<HintBadge tool={t} />}
                  enabled={!s.disabledTools.includes(t.name)}
                  onToggle={(v) => setServerToolEnabled(s.id, t.name, v)}
                  dimmed={!s.enabled}
                  onInspect={() =>
                    onInspect({
                      name: t.name,
                      source: `${s.name} (${s.runsOn === 'local' ? `local, ${mac?.name ?? 'Mac'}` : 'remote'})`,
                      description: t.description,
                      inputSchema: t.inputSchema,
                      annotations: t.annotations,
                      rule: `Mcp(${s.slug}:${t.name})`,
                    })
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

const detail = (s: McpServer) => s.url ?? [s.command, ...(s.args ?? [])].filter(Boolean).join(' ');

/** Read-only tools run without asking; the rest ask first, as any outbound action does. */
function HintBadge({ tool }: { tool: McpToolInfo }) {
  return tool.annotations?.readOnlyHint ? (
    <Badge className="text-muted-foreground">read-only</Badge>
  ) : (
    <Badge className="text-muted-foreground" title="Asks for approval unless always allowed">
      asks first
    </Badge>
  );
}

function ToolRow({
  name,
  description,
  badge,
  enabled,
  onToggle,
  onInspect,
  locked,
  dimmed,
}: {
  name: string;
  description: string;
  badge?: React.ReactNode;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  onInspect: () => void;
  locked?: boolean;
  dimmed?: boolean;
}) {
  return (
    <li
      className={cn(
        'flex items-center gap-3 px-4 py-2 hover:bg-accent/40',
        (!enabled || dimmed) && 'opacity-60',
      )}
    >
      <button type="button" onClick={onInspect} className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2">
          <code className="text-sm font-medium">{name}</code>
          {badge}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {firstLine(description)}
        </span>
      </button>
      <Switch
        checked={enabled}
        onChange={onToggle}
        disabled={locked}
        label={`${name} on`}
        title={locked ? 'Always on' : enabled ? 'On' : 'Off'}
      />
    </li>
  );
}

const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? '';

function RemoteServerDialog({
  open,
  server,
  onClose,
}: {
  open: boolean;
  server?: McpServer;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={server ? `Edit ${server.name}` : 'Add a remote MCP server'}
    >
      <RemoteServerForm key={server?.id ?? 'new'} server={server} onDone={onClose} />
    </Dialog>
  );
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .slice(0, 24);

function RemoteServerForm({ server, onDone }: { server?: McpServer; onDone: () => void }) {
  const [name, setName] = useState(server?.name ?? '');
  const [slug, setSlug] = useState(server?.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(!!server);
  const [url, setUrl] = useState(server?.url ?? '');
  const [auth, setAuth] = useState('');
  const [removeAuth, setRemoveAuth] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const effectiveSlug = slugTouched ? slug : slugify(name);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await saveRemoteServer({
        ...(server ? { id: server.id } : {}),
        name: name.trim(),
        slug: effectiveSlug,
        url: url.trim(),
        ...(removeAuth
          ? { authorization: null }
          : auth.trim()
            ? { authorization: auth.trim() }
            : {}),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Linear"
            required
          />
        </label>
        <label>
          <Label>Short name (tool names and rules)</Label>
          <Input
            value={effectiveSlug}
            disabled={!!server}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
            placeholder="linear"
            pattern="[a-z][a-z0-9\-]{0,23}"
            required
          />
        </label>
      </div>
      <label className="block">
        <Label>URL (streamable HTTP)</Label>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://mcp.linear.app/mcp"
          required
        />
      </label>
      <label className="block">
        <Label>Authorization header (optional)</Label>
        <Input
          type="password"
          autoComplete="off"
          value={auth}
          disabled={removeAuth}
          onChange={(e) => setAuth(e.target.value)}
          placeholder={server?.hasAuth ? 'Stored; leave empty to keep it' : 'Bearer …'}
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          Kept in Secret Manager and only handed to runs that use this server; never shown again.
          Servers that sign in with OAuth are not supported yet.
        </span>
      </label>
      {server?.hasAuth && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={removeAuth}
            onChange={(e) => setRemoveAuth(e.target.checked)}
          />
          Remove the stored header
        </label>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {server ? 'Save and reload tools' : 'Add and load tools'}
        </Button>
      </div>
    </form>
  );
}

function LocalServerDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Add an MCP server on your Mac">
      <div className="space-y-3 text-sm">
        <p>
          Local servers are added on the Mac itself, like folders: the cloud can turn one off, but
          it can never make your Mac run a new command. In the dodo folder on your Mac:
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
          {`pnpm dodo mcp add outlook --title "Outlook" -- npx -y <outlook-mcp-package>
# environment values stay on the Mac:
pnpm dodo mcp add db --env DATABASE_URL=postgres://… -- npx -y <db-mcp-package>
# or a server already listening on the Mac:
pnpm dodo mcp add notes --url http://localhost:3000/mcp`}
        </pre>
        <p>
          It starts once in that terminal, so a sign-in it asks for (a code to enter, a browser
          window) happens there; the server keeps its own sign-in after that. It then shows up here
          with its tools. <code>pnpm dodo mcp test &lt;name&gt;</code> signs in again;{' '}
          <code>pnpm dodo mcp remove &lt;name&gt;</code> removes it.
        </p>
        <p className="text-muted-foreground">
          The daemon runs local servers outside the sandbox, as you, and only tasks running on that
          Mac get their tools.
        </p>
      </div>
    </Dialog>
  );
}

/* ------------------------------ built-in ------------------------------ */

const GROUP_ORDER: BuiltinGroup[] = [
  'core',
  'task',
  'vault',
  'exec',
  'web',
  'google',
  'notion',
  'github',
  'browser',
];

function BuiltinTab({ onInspect }: { onInspect: (t: Inspected) => void }) {
  const { data: toolSettings } = useToolSettings();
  const disabled = new Set(toolSettings.disabledBuiltins);
  return (
    <div className="space-y-3">
      {GROUP_ORDER.map((g) => {
        const tools = BUILTIN_TOOLS.filter((t) => t.group === g);
        if (!tools.length) return null;
        return (
          <Card key={g}>
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-2">
              <div>
                <h3 className="text-sm font-medium">{GROUPS[g].label}</h3>
                <p className="text-xs text-muted-foreground">{GROUPS[g].note}</p>
              </div>
              <Availability group={g} />
            </div>
            <ul className="divide-y border-t">
              {tools.map((t) => {
                const core = CORE_TOOLS.includes(t.name);
                return (
                  <ToolRow
                    key={t.name}
                    name={t.name}
                    description={t.description}
                    enabled={core || !disabled.has(t.name)}
                    locked={core}
                    onToggle={(v) => setBuiltinEnabled(t.name, v)}
                    onInspect={() => onInspect(inspectBuiltin(t))}
                  />
                );
              })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

function Availability({ group }: { group: BuiltinGroup }) {
  const both = (
    <>
      <Badge>
        <Laptop className="h-3 w-3" /> Mac
      </Badge>
      <Badge>
        <Cloud className="h-3 w-3" /> Remote
      </Badge>
    </>
  );
  if (group === 'browser')
    return (
      <span className="flex gap-1">
        <Badge>
          <Laptop className="h-3 w-3" /> Mac: your Chrome
        </Badge>
        <Badge>
          <Cloud className="h-3 w-3" /> Remote: headless
        </Badge>
      </span>
    );
  return <span className="flex gap-1">{both}</span>;
}

const inspectBuiltin = (t: BuiltinTool): Inspected => ({
  name: t.name,
  source: `Built-in · ${GROUPS[t.group].label}`,
  description: t.description,
  inputSchema: t.inputSchema,
  rule: RULE_OF[t.name],
});

/** The rule family each built-in's approvals use, for the inspect dialog. */
const RULE_OF: Record<string, string> = {
  bash: 'Bash(<command>)',
  read_file: 'Read(<path>)',
  write_file: 'Write(<path>)',
  http_fetch: 'Http(domain:<host>)',
  web_search: 'WebSearch(<query>)',
  gmail_search: 'Gmail(search:<query>)',
  gmail_read_thread: 'Gmail(read:<thread>)',
  calendar_list_events: 'Calendar(list)',
  calendar_create_event: 'Calendar(create:<title>)',
  drive_search: 'Drive(search:<text>)',
  drive_read: 'Drive(read:<file>)',
  drive_download: 'Drive(read:<file>)',
  drive_save_file: 'Drive(save:<name>)',
  drive_update_file: 'Drive(edit:<file>)',
  notion_search: 'Notion(search:<query>)',
  notion_read_page: 'Notion(read:<page>)',
  notion_query_database: 'Notion(read:<database>)',
  notion_create_page: 'Notion(create:<parent>)',
  notion_update_page: 'Notion(edit:<page>) or Notion(trash:<page>)',
  notion_append_to_page: 'Notion(edit:<page>)',
  push_branch: 'GitHub(push:<repo>)',
  open_pull_request: 'GitHub(pr:<repo>)',
  request_vault_access: 'Vault(<entry>)',
  browser_navigate: 'Browser(navigate:<host>)',
};

/* ------------------------------ toolsets ------------------------------ */

function ToolsetsTab({ servers, toolsets }: { servers: McpServer[]; toolsets: Toolset[] }) {
  const [editing, setEditing] = useState<Toolset | 'new'>();
  const { data: tasks } = useTasks();
  const { data: projects } = useProjects();
  const usedBy = (id: string) => ({
    tasks: tasks.filter((t) => t.ai.toolsets?.includes(id)).length,
    projects: projects.filter((p) => p.defaults.toolsets?.includes(id)).length,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-xl text-sm text-muted-foreground">
          A toolset is a preset you attach to a task or project. The agent then gets only those
          tools, plus the task basics; the browser and GitHub still follow the task’s own settings.
          Without a toolset a task gets every tool that is on.
        </p>
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-3.5 w-3.5" /> New toolset
        </Button>
      </div>
      {toolsets.length === 0 && (
        <Card>
          <CardBody className="text-center text-sm text-muted-foreground">
            No toolsets yet. Try one like “Email”: Outlook’s tools and nothing else.
          </CardBody>
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {toolsets.map((t) => {
          const used = usedBy(t.id);
          return (
            <Card key={t.id} className="flex flex-col">
              <div className="flex items-start gap-2 px-4 pt-3">
                <div className="min-w-0 flex-1">
                  <h3 className="font-medium">{t.name}</h3>
                  {t.description && (
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  )}
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setEditing(t)}
                  aria-label={`Edit ${t.name}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${t.name}`}
                  onClick={() => {
                    if (
                      confirm(
                        `Delete the toolset ${t.name}? Tasks that use it get every tool again.`,
                      )
                    )
                      void deleteToolset(t.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="flex flex-wrap gap-1 px-4 py-2">
                {t.tools.length === 0 && (
                  <span className="text-xs text-muted-foreground">Only the task basics</span>
                )}
                {t.tools.map((r) => (
                  <Badge key={r} className="font-mono font-normal">
                    {refLabel(r, servers)}
                  </Badge>
                ))}
              </div>
              <p className="mt-auto border-t px-4 py-2 text-xs text-muted-foreground">
                {used.tasks || used.projects
                  ? `Used by ${[
                      used.tasks && `${used.tasks} task${used.tasks > 1 ? 's' : ''}`,
                      used.projects && `${used.projects} project${used.projects > 1 ? 's' : ''}`,
                    ]
                      .filter(Boolean)
                      .join(' and ')}`
                  : 'Not attached yet: pick it on a task or project'}
              </p>
            </Card>
          );
        })}
      </div>
      <Dialog
        open={!!editing}
        onClose={() => setEditing(undefined)}
        title={editing === 'new' ? 'New toolset' : `Edit ${editing?.name ?? ''}`}
        className="w-[min(760px,calc(100vw-32px))]"
      >
        <ToolsetForm
          key={editing === 'new' ? 'new' : editing?.id}
          toolset={editing === 'new' ? undefined : editing}
          servers={servers}
          onDone={() => setEditing(undefined)}
        />
      </Dialog>
    </div>
  );
}

function refLabel(ref: string, servers: McpServer[]): string {
  if (ref.startsWith('builtin:')) return ref.slice(8);
  const [, slug, tool] = ref.split(':');
  const server = servers.find((s) => s.slug === slug);
  return `${server?.name ?? slug}${tool === '*' ? ' (all)' : `: ${tool}`}`;
}

function ToolsetForm({
  toolset,
  servers,
  onDone,
}: {
  toolset?: Toolset;
  servers: McpServer[];
  onDone: () => void;
}) {
  const [name, setName] = useState(toolset?.name ?? '');
  const [description, setDescription] = useState(toolset?.description ?? '');
  const [refs, setRefs] = useState<Set<string>>(new Set(toolset?.tools ?? []));
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const toggle = (ref: string, on: boolean) => {
    const next = new Set(refs);
    if (on) next.add(ref);
    else next.delete(ref);
    setRefs(next);
  };
  const has = (target: string) => [...refs].some((r) => refMatches(r, target));
  const matchesFilter = (n: string, d = '') =>
    !filter || `${n} ${d}`.toLowerCase().includes(filter.toLowerCase());
  const builtinGroups = GROUP_ORDER.filter((g) => GROUPS[g].toolsets);
  // Local servers with the same short name (two Macs) pick the same tools: show them once.
  const bySlug = useMemo(() => {
    const m = new Map<string, McpServer>();
    for (const s of servers) if (!m.has(s.slug) || s.catalog) m.set(s.slug, s);
    return [...m.values()];
  }, [servers]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await saveToolset({
        ...(toolset ? { id: toolset.id } : {}),
        name: name.trim(),
        description: description.trim(),
        tools: [...refs].sort(),
      });
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <label>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Email"
            required
          />
        </label>
        <label>
          <Label>Description</Label>
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Read and answer mail in Outlook"
          />
        </label>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder="Filter tools"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
        {bySlug.map((s) => {
          const all = mcpRef(s.slug, '*');
          const tools = (s.catalog?.tools ?? []).filter((t) =>
            matchesFilter(t.name, t.description),
          );
          if (filter && !tools.length && !matchesFilter(s.name)) return null;
          return (
            <PickerGroup
              key={s.id}
              title={s.name}
              subtitle={s.runsOn === 'local' ? 'Local (Mac)' : 'Remote'}
              all={refs.has(all)}
              onAll={(v) => toggle(all, v)}
              allLabel="Every tool, also ones it adds later"
            >
              {s.catalog ? (
                tools.map((t) => (
                  <PickerItem
                    key={t.name}
                    name={t.name}
                    description={t.description}
                    checked={has(mcpRef(s.slug, t.name))}
                    disabled={refs.has(all)}
                    onChange={(v) => toggle(mcpRef(s.slug, t.name), v)}
                  />
                ))
              ) : (
                <p className="px-3 py-2 text-xs text-muted-foreground">
                  Tools not loaded yet; pick “every tool” or refresh the server first.
                </p>
              )}
            </PickerGroup>
          );
        })}
        {builtinGroups.map((g) => {
          const tools = BUILTIN_TOOLS.filter(
            (t) => t.group === g && matchesFilter(t.name, t.description),
          );
          if (!tools.length) return null;
          return (
            <PickerGroup key={g} title={GROUPS[g].label} subtitle="Built-in">
              {tools.map((t) => (
                <PickerItem
                  key={t.name}
                  name={t.name}
                  description={t.description}
                  checked={has(builtinRef(t.name))}
                  onChange={(v) => toggle(builtinRef(t.name), v)}
                />
              ))}
            </PickerGroup>
          );
        })}
      </div>
      <div className="flex items-center justify-between gap-2 border-t pt-3">
        <span className="text-xs text-muted-foreground">
          {refs.size} picked · task basics always included
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Save toolset
          </Button>
        </div>
      </div>
    </form>
  );
}

function PickerGroup({
  title,
  subtitle,
  all,
  onAll,
  allLabel,
  children,
}: {
  title: string;
  subtitle: string;
  all?: boolean;
  onAll?: (v: boolean) => void;
  allLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-2">
        <span>
          <span className="font-medium">{title}</span>{' '}
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </span>
        {onAll && (
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={all} onChange={(e) => onAll(e.target.checked)} />
            {allLabel}
          </label>
        )}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  );
}

function PickerItem({
  name,
  description,
  checked,
  disabled,
  onChange,
}: {
  name: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={cn('flex items-start gap-2 px-3 py-1.5', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        className="mt-1"
        checked={checked || !!disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <code className="text-xs font-medium">{name}</code>
        <span className="block truncate text-xs text-muted-foreground">
          {firstLine(description)}
        </span>
      </span>
    </label>
  );
}

/* ---------------------------- permissions ---------------------------- */

function PermissionsTab() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Rules you answered “Allow always” on an approval. Remove one and the agent asks again next
        time. MCP tools use <code>Mcp(server:tool)</code>; built-ins use rules like{' '}
        <code>Bash(git push:*)</code> or <code>Browser(navigate:site.com)</code>.
      </p>
      <AllowedActionsSettings />
    </div>
  );
}

/* ------------------------------ inspect ------------------------------ */

interface SchemaProp {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: SchemaProp;
  default?: unknown;
  anyOf?: SchemaProp[];
}

const typeOf = (p: SchemaProp): string => {
  if (p.enum) return p.enum.map((v) => JSON.stringify(v)).join(' | ');
  if (p.anyOf) return p.anyOf.map(typeOf).join(' | ');
  const t = Array.isArray(p.type) ? p.type.join(' | ') : (p.type ?? 'any');
  return t === 'array' && p.items ? `${typeOf(p.items)}[]` : t;
};

function ToolDialog({ tool, onClose }: { tool?: Inspected; onClose: () => void }) {
  const [raw, setRaw] = useState(false);
  const props = (tool?.inputSchema.properties ?? {}) as Record<string, SchemaProp>;
  const required = new Set((tool?.inputSchema.required as string[] | undefined) ?? []);
  const hints = tool?.annotations
    ? (
        [
          ['readOnlyHint', 'read-only'],
          ['destructiveHint', 'destructive'],
          ['idempotentHint', 'idempotent'],
          ['openWorldHint', 'reaches outside'],
        ] as const
      ).filter(([k]) => tool.annotations?.[k] === true)
    : [];
  return (
    <Dialog
      open={!!tool}
      onClose={() => {
        setRaw(false);
        onClose();
      }}
      title={tool?.name ?? ''}
      className="w-[min(760px,calc(100vw-32px))]"
    >
      {tool && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{tool.source}</Badge>
            {hints.map(([k, label]) => (
              <Badge key={k} className="text-muted-foreground">
                {label}
              </Badge>
            ))}
            {tool.rule && (
              <span className="text-xs text-muted-foreground">
                Approval rule <code>{tool.rule}</code>
              </span>
            )}
          </div>
          <div>
            <Label>Description (what the model reads)</Label>
            <p className="rounded-md bg-muted/50 p-3 whitespace-pre-wrap">
              {tool.description || 'No description.'}
            </p>
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <Label className="mb-0">Parameters</Label>
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                onClick={() => setRaw(!raw)}
              >
                {raw ? 'Show table' : 'Show JSON schema'}
              </button>
            </div>
            {raw ? (
              <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(tool.inputSchema, null, 2)}
              </pre>
            ) : Object.keys(props).length === 0 ? (
              <p className="text-xs text-muted-foreground">None.</p>
            ) : (
              <div className="overflow-hidden rounded-md border">
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y">
                    {Object.entries(props).map(([key, p]) => (
                      <tr key={key} className="align-top">
                        <td className="w-1/3 px-3 py-2">
                          <code className="font-medium">{key}</code>
                          {required.has(key) && <span className="ml-1 text-danger">*</span>}
                          <div className="font-mono text-muted-foreground">{typeOf(p)}</div>
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {p.description}
                          {p.default !== undefined && (
                            <span className="block">Default: {JSON.stringify(p.default)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
