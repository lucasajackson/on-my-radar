export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 accent-[color:var(--accent-from)]"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-[13.5px] font-medium">{label}</span>
        <span className="mt-0.5 block text-[12.5px] leading-relaxed text-[color:var(--paper-dim)]">
          {hint}
        </span>
      </span>
    </label>
  );
}
