import { useState } from "react";
import type { TableDetail } from "../api";

export interface AddRowFormProps {
  detail: TableDetail;
  enums: Array<{ name: string; values: string[] }>;
  onStage: (values: Record<string, string | number | boolean | null>) => void;
  onClose: () => void;
}

type Draft = Record<string, string | boolean | null>;

function isEnumColumn(column: TableDetail["columns"][number], enums: AddRowFormProps["enums"]) {
  return (
    column.dataType === "USER-DEFINED" &&
    enums.some(enumType => enumType.name === column.udtName)
  );
}

/**
 * Insert form driven purely by catalog metadata: required flags come from
 * nullability + defaults, enum columns become selects over pg_enum labels.
 * Optional empty fields are omitted so database defaults apply.
 */
export function AddRowForm({ detail, enums, onStage, onClose }: AddRowFormProps) {
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);

  function setValue(column: string, value: string | boolean | null) {
    setDraft(current => ({ ...current, [column]: value }));
  }

  function submit() {
    setError(null);
    const values: Record<string, string | number | boolean | null> = {};
    for (const column of detail.columns) {
      const raw = draft[column.name];
      const required = !column.nullable && !column.hasDefault;
      const empty = raw === undefined || raw === null || raw === "";

      if (required && empty) {
        setError(`"${column.name}" is required`);
        return;
      }
      if (empty) continue;

      if (typeof raw === "boolean") {
        values[column.name] = raw;
        continue;
      }
      const numeric =
        column.dataType.startsWith("int") ||
        column.dataType.startsWith("numeric") ||
        column.dataType.startsWith("double") ||
        column.dataType === "real";
      if (numeric) {
        const parsed = Number(raw);
        if (Number.isNaN(parsed)) {
          setError(`"${column.name}" must be a number`);
          return;
        }
        values[column.name] = parsed;
        continue;
      }
      values[column.name] = raw;
    }
    onStage(values);
    setDraft({});
  }

  return (
    <form
      aria-label="add row"
      className="border-b border-border bg-muted p-3"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-wrap gap-3">
        {detail.columns.map(column => {
          const required = !column.nullable && !column.hasDefault;
          const enumType = enums.find(candidate => candidate.name === column.udtName);
          return (
            <label key={column.name} className="flex flex-col gap-1 text-xs">
              <span>
                {column.name}
                {required ? <span aria-hidden> *</span> : null}
                {required ? <span className="sr-only"> (required)</span> : null}
                {!required ? <span className="ml-1 text-muted-foreground">optional</span> : null}
              </span>
              {isEnumColumn(column, enums) ? (
                <select
                  aria-label={`${column.name} value`}
                  value={String(draft[column.name] ?? "")}
                  onChange={event =>
                    setValue(
                      column.name,
                      event.target.value === "" ? null : event.target.value,
                    )
                  }
                  className="rounded border border-border bg-background px-2 py-1"
                >
                  <option value="">—</option>
                  {(enums.find(e => e.name === column.udtName)?.values ?? []).map(option => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : column.dataType === "boolean" ? (
                <input
                  type="checkbox"
                  aria-label={`${column.name} value`}
                  checked={Boolean(draft[column.name])}
                  onChange={event => setValue(column.name, event.target.checked)}
                />
              ) : (
                <input
                  aria-label={`${column.name} value`}
                  value={typeof draft[column.name] === "boolean" ? String(draft[column.name]) : (draft[column.name] as string) ?? ""}
                  onChange={event => setValue(column.name, event.target.value)}
                  className="w-44 rounded border border-border bg-background px-2 py-1"
                />
              )}
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex gap-2">
        <button
          type="submit"
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          Stage insert
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-3 py-1 text-sm"
        >
          Close
        </button>
      </div>
    </form>
  );
}
