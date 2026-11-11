import * as Primitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Fragment, useRef, useState, type CSSProperties } from 'react';

/**
 * The shared single-choice control — and the only one. A native `<select>`
 * opens the operating system's menu, which matches the OS rather than the app
 * (the owner: "dropdowns in the UI need to match the UI, not the system"), so
 * JSX `<select>` is an ESLint error in packages/ui.
 */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /**
   * A quieter second line under the label, in the open menu only — "reads
   * AGENTS.md" under "Codex CLI". The trigger shows the label alone.
   */
  description?: string;
}

/** A labelled run of options: "This agent's profiles", "Add a profile for…". */
export interface SelectGroup {
  label: string;
  options: readonly SelectOption[];
}

export interface SelectProps {
  value: string;
  onValueChange: (value: string) => void;
  /** Flat options. Give `groups` instead to label runs of them; not both. */
  options?: readonly SelectOption[];
  groups?: readonly SelectGroup[];
  id?: string;
  name?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** Anchor a wider menu to the trailing edge of a compact toolbar trigger. */
  menuAlign?: 'start' | 'center' | 'end';
  /**
   * `primary` paints the trigger as the page's primary action — the agent
   * page's "Use in…", which is a menu of tools rather than a form field.
   */
  tone?: 'field' | 'primary';
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  placeholder?: string;
}

// Prefix every value so an empty application value is a real selectable option,
// distinct from Radix's empty placeholder value, without sentinel collisions.
const encode = (value: string) => `option:${value}`;
const TOKENS = [
  '--ink-800',
  '--ink-850',
  '--paper',
  '--paper-dim',
  '--paper-faint',
  '--line',
  '--line-soft',
  '--accent-from',
] as const;

function Item({ option }: { option: SelectOption }) {
  return (
    <Primitive.Item
      value={encode(option.value)}
      disabled={option.disabled ?? false}
      textValue={option.label}
      className={`select-option ${option.description ? 'has-description' : ''}`}
      data-value={option.value}
    >
      <span className="select-option-text">
        <Primitive.ItemText>{option.label}</Primitive.ItemText>
        {option.description ? (
          <span className="select-option-description">{option.description}</span>
        ) : null}
      </span>
      <Primitive.ItemIndicator className="select-check">
        <Check size={16} aria-hidden="true" />
      </Primitive.ItemIndicator>
    </Primitive.Item>
  );
}

/** The shared single-choice control. Keep editable search comboboxes separate. */
export function Select({
  value,
  onValueChange,
  options = [],
  groups,
  id,
  name,
  disabled,
  required,
  className = '',
  menuAlign = 'start',
  tone = 'field',
  placeholder = 'Choose…',
  ...aria
}: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<HTMLElement | undefined>();
  const [theme, setTheme] = useState<CSSProperties>({});
  const every = groups ? groups.flatMap((group) => group.options) : options;
  const selected = every.some((option) => option.value === value) && !(required && value === '');
  const displayPlaceholder =
    value === ''
      ? (every.find((option) => option.value === '')?.label ?? placeholder)
      : placeholder;
  return (
    <Primitive.Root
      value={selected ? encode(value) : ''}
      onValueChange={(next) => onValueChange(next.slice('option:'.length))}
      disabled={disabled ?? false}
      required={required ?? false}
      onOpenChange={(open) => {
        if (!open || !trigger.current) return;
        // Keep portaled options inside the owning modal's focus/inert boundary.
        setContainer(
          trigger.current.closest<HTMLElement>('[role="dialog"], [popover]') ?? undefined,
        );
        const computed = getComputedStyle(trigger.current);
        setTheme(
          Object.fromEntries(TOKENS.map((token) => [token, computed.getPropertyValue(token)])),
        );
      }}
    >
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
      <Primitive.Trigger
        ref={trigger}
        id={id}
        {...aria}
        className={`select-trigger ${tone === 'primary' ? 'is-primary' : ''} ${className}`}
        data-value={value}
      >
        <Primitive.Value placeholder={displayPlaceholder} />
        <Primitive.Icon className="select-chevron">
          <ChevronDown size={16} aria-hidden="true" />
        </Primitive.Icon>
      </Primitive.Trigger>
      <Primitive.Portal container={container}>
        <Primitive.Content
          className="select-content"
          style={theme}
          position="popper"
          align={menuAlign}
          sideOffset={6}
          collisionPadding={12}
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Primitive.ScrollUpButton className="select-scroll">
            <ChevronUp size={16} />
          </Primitive.ScrollUpButton>
          <Primitive.Viewport className="select-viewport">
            {groups
              ? groups.map((group, index) => (
                  <Fragment key={group.label}>
                    {index > 0 ? <Primitive.Separator className="select-separator" /> : null}
                    <Primitive.Group>
                      <Primitive.Label className="select-group-label">
                        {group.label}
                      </Primitive.Label>
                      {group.options.map((option) => (
                        <Item key={option.value} option={option} />
                      ))}
                    </Primitive.Group>
                  </Fragment>
                ))
              : options.map((option) => <Item key={option.value} option={option} />)}
          </Primitive.Viewport>
          <Primitive.ScrollDownButton className="select-scroll">
            <ChevronDown size={16} />
          </Primitive.ScrollDownButton>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
