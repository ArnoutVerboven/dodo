import { Check, ChevronDown, Plus, RotateCcw, Search, X } from 'lucide-react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/utils';

/** One choice in a dropdown. `icon` leads, `trailing` (say a small "local" icon) follows the label. */
export interface DropdownOption {
  value: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  /** Class for the icon, e.g. a status colour. */
  tone?: string;
  trailing?: ReactNode;
  /** Shown on hover. */
  title?: string;
}

/** Free text the menu also takes (a repo name, a folder path): turns the typed text into a value. */
export interface CustomEntry {
  /** Returns the value for the text, or undefined while it is not one yet. */
  accept: (text: string) => string | undefined;
  /** Shown in the menu row that adds it, e.g. `Use "${text}"`. */
  label?: (value: string) => string;
}

const MENU_MAX = 288;

/**
 * Where the menu goes: under the trigger, or above it when there is no room below. Fixed, so
 * neither a card's overflow nor a modal dialog clips it (the menu stays inside the dialog's DOM,
 * where a portal to the body would sit under the modal and not take clicks).
 */
function useMenuPosition(open: boolean, trigger: React.RefObject<HTMLElement | null>) {
  const [style, setStyle] = useState<CSSProperties>({
    // Out of the flow from the first render: in it, the menu would grow (and re-centre) a dialog
    // for a moment and be placed against that layout.
    position: 'fixed',
    top: 0,
    left: 0,
    visibility: 'hidden',
  });
  const place = useCallback(() => {
    const el = trigger.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const below = vh - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 200 && above > below;
    const width = Math.min(Math.max(r.width, 200), 340, vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    setStyle({
      position: 'fixed',
      left,
      width,
      maxHeight: Math.min(MENU_MAX, up ? above : below),
      ...(up ? { bottom: vh - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, [trigger]);
  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);
  return style;
}

interface PickerProps {
  options: DropdownOption[];
  selected: string[];
  multiple: boolean;
  onPick: (value: string) => void;
  /** Shown as the menu's last row when set: puts the field back to its default. */
  onReset?: () => void;
  resetLabel?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  custom?: CustomEntry;
  empty?: ReactNode;
  footer?: ReactNode;
  ariaLabel: string;
  disabled?: boolean;
  triggerClassName?: string;
  children: ReactNode;
}

/** The shared trigger and menu behind Dropdown and MultiDropdown. */
function Picker({
  options,
  selected,
  multiple,
  onPick,
  onReset,
  resetLabel = 'Use default',
  searchable,
  searchPlaceholder = 'Search…',
  custom,
  empty = 'Nothing to pick',
  footer,
  ariaLabel,
  disabled,
  triggerClassName,
  children,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();
  const style = useMenuPosition(open, trigger);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q
      ? options.filter(
          (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
        )
      : options;
    const out: Array<
      | { kind: 'option'; option: DropdownOption }
      | { kind: 'custom'; value: string }
      | { kind: 'reset' }
    > = shown.map((option) => ({ kind: 'option' as const, option }));
    const typed = custom && query.trim() ? custom.accept(query.trim()) : undefined;
    if (typed && !options.some((o) => o.value.toLowerCase() === typed.toLowerCase()))
      out.push({ kind: 'custom', value: typed });
    if (onReset && !q) out.push({ kind: 'reset' });
    return out;
  }, [options, query, custom, onReset]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setQuery('');
    if (refocus) trigger.current?.focus();
  }, []);

  const openMenu = () => {
    if (disabled) return;
    const at = options.findIndex((o) => selected.includes(o.value));
    setActive(Math.max(0, at));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    if (searchable || custom) search.current?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !menu.current?.contains(t)) close(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open, searchable, custom, close]);

  // Keep the active row in view while moving with the keyboard.
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector(`[data-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === 'reset') {
      onReset?.();
      close();
      return;
    }
    const value = row.kind === 'custom' ? row.value : row.option.value;
    onPick(value);
    if (row.kind === 'custom') setQuery('');
    if (!multiple) close();
  };

  const onKey = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(rows.length - 1);
    } else if (e.key === 'Enter' || (e.key === ' ' && !(searchable || custom))) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        aria-activedescendant={open && !(searchable || custom) ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKey}
        className={triggerClassName}
      >
        {children}
      </button>
      {open && (
        <div
          ref={menu}
          id={`${id}-menu`}
          style={style}
          className="z-50 flex flex-col overflow-hidden rounded-lg border bg-card text-sm shadow-lg ring-1 ring-black/5"
        >
          {(searchable || custom) && (
            <div className="flex items-center gap-2 border-b px-2.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={search}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                aria-controls={`${id}-list`}
                aria-activedescendant={`${id}-${active}`}
                className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}
          <div
            id={`${id}-list`}
            role="listbox"
            aria-label={ariaLabel}
            aria-multiselectable={multiple || undefined}
            className="min-h-0 flex-1 overflow-y-auto p-1"
          >
            {rows.length === 0 && (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">{empty}</div>
            )}
            {rows.map((row, i) => {
              const key = row.kind === 'option' ? row.option.value : `__${row.kind}`;
              const isOn = row.kind === 'option' && selected.includes(row.option.value);
              const Icon =
                row.kind === 'option' ? row.option.icon : row.kind === 'custom' ? Plus : RotateCcw;
              const label =
                row.kind === 'option'
                  ? row.option.label
                  : row.kind === 'custom'
                    ? (custom?.label?.(row.value) ?? `Use “${row.value}”`)
                    : resetLabel;
              return (
                <div
                  key={key}
                  id={`${id}-${i}`}
                  data-row={i}
                  role="option"
                  aria-selected={isOn}
                  tabIndex={-1}
                  title={row.kind === 'option' ? row.option.title : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(i)}
                  onKeyDown={onKey}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 select-none',
                    i === active && 'bg-accent',
                    row.kind === 'reset' && 'mt-1 border-t pt-2 text-muted-foreground',
                  )}
                >
                  {multiple && row.kind === 'option' ? (
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                        isOn && 'border-primary bg-primary text-primary-foreground',
                      )}
                    >
                      {isOn && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
                    </span>
                  ) : (
                    Icon && (
                      <Icon
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          row.kind === 'option' ? row.option.tone : 'text-muted-foreground',
                        )}
                      />
                    )
                  )}
                  {multiple && row.kind === 'option' && Icon && (
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', row.option.tone)} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  {row.kind === 'option' && row.option.trailing}
                  {!multiple && isOn && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                </div>
              );
            })}
          </div>
          {footer && (
            <div className="border-t px-2.5 py-1.5 text-xs text-muted-foreground">{footer}</div>
          )}
        </div>
      )}
    </>
  );
}

/** The look of a form field, for the trigger of a dropdown that sits among inputs. */
export const fieldTrigger =
  'flex h-9 w-full items-center gap-2 rounded-md border bg-card px-3 text-left text-sm outline-none transition hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60';

function OptionFace({ option, muted }: { option: DropdownOption; muted?: boolean }) {
  const Icon = option.icon;
  return (
    <>
      {Icon && <Icon className={cn('h-3.5 w-3.5 shrink-0', muted ? 'opacity-70' : option.tone)} />}
      <span className="min-w-0 truncate">{option.label}</span>
      {option.trailing}
    </>
  );
}

/**
 * A dropdown in the app's own style (no OS menu). Empty `value` means "inherit": the trigger then
 * shows `inherited` (the value that applies, muted, marked as the default) or `placeholder`.
 * With `onReset`, a set value can be cleared back to the default from the menu.
 */
export function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = 'Pick one',
  inherited,
  inheritedNote = 'default',
  onReset,
  resetLabel,
  searchable,
  custom,
  footer,
  className,
  children,
  triggerClassName,
  disabled,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: ReactNode;
  /** The option that applies while `value` is empty. */
  inherited?: DropdownOption;
  inheritedNote?: string;
  onReset?: () => void;
  resetLabel?: string;
  searchable?: boolean;
  custom?: CustomEntry;
  footer?: ReactNode;
  className?: string;
  /** Replaces the trigger's face (e.g. a compact chip); `triggerClassName` then styles it. */
  children?: ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
}) {
  const current =
    options.find((o) => o.value === value) ?? (value ? { value, label: value } : undefined);
  return (
    <Picker
      options={options}
      selected={value ? [value] : []}
      multiple={false}
      onPick={onChange}
      onReset={value && onReset ? onReset : undefined}
      resetLabel={resetLabel}
      searchable={searchable}
      custom={custom}
      footer={footer}
      ariaLabel={ariaLabel}
      disabled={disabled}
      triggerClassName={triggerClassName ?? cn(fieldTrigger, className)}
    >
      {children ?? (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            {current ? (
              <OptionFace option={current} />
            ) : inherited ? (
              <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                <OptionFace option={inherited} muted />
                <span className="shrink-0 text-xs opacity-70">· {inheritedNote}</span>
              </span>
            ) : (
              <span className="truncate text-muted-foreground">{placeholder}</span>
            )}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </>
      )}
    </Picker>
  );
}

/**
 * A dropdown that picks several. Empty `values` shows `inherited` (what applies instead, muted)
 * or `placeholder`. Picked values show as small chips that can be removed in place.
 */
export function MultiDropdown({
  values,
  options,
  onChange,
  ariaLabel,
  placeholder = 'None',
  inherited,
  inheritedNote = 'default',
  searchable,
  searchPlaceholder,
  custom,
  empty,
  footer,
  className,
  disabled,
}: {
  values: string[];
  options: DropdownOption[];
  onChange: (values: string[]) => void;
  ariaLabel: string;
  placeholder?: ReactNode;
  inherited?: string[];
  inheritedNote?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  custom?: CustomEntry;
  empty?: ReactNode;
  footer?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  // Values typed in that are not among the options still show (and can be unticked).
  const all = useMemo(
    () => [
      ...options,
      ...values
        .filter((v) => !options.some((o) => o.value === v))
        .map((v) => ({ value: v, label: v })),
    ],
    [options, values],
  );
  const toggle = (v: string) =>
    onChange(values.includes(v) ? values.filter((x) => x !== v) : [...values, v]);
  const labelOf = (v: string) => all.find((o) => o.value === v)?.label ?? v;
  return (
    <div className={cn('relative', className)}>
      <Picker
        options={all}
        selected={values}
        multiple
        onPick={toggle}
        searchable={searchable}
        searchPlaceholder={searchPlaceholder}
        custom={custom}
        empty={empty}
        footer={footer}
        ariaLabel={ariaLabel}
        disabled={disabled}
        triggerClassName={cn(fieldTrigger, 'h-auto min-h-9 py-1', values.length && 'pr-8')}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {values.length ? (
            values.map((v) => (
              <span
                key={v}
                className="inline-flex h-6 max-w-full items-center gap-1 rounded bg-muted px-1.5 text-xs"
              >
                <span className="truncate">{labelOf(v)}</span>
              </span>
            ))
          ) : inherited?.length ? (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span className="truncate">{inherited.map(labelOf).join(', ')}</span>
              <span className="shrink-0 text-xs opacity-70">· {inheritedNote}</span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">{placeholder}</span>
          )}
        </span>
        {!values.length && <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
      </Picker>
      {values.length > 0 && !disabled && (
        <button
          type="button"
          aria-label={`Clear ${ariaLabel}`}
          title="Clear"
          onClick={() => onChange([])}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
