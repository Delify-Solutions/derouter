"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import PropTypes from "prop-types";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import QueueEntryCard from "./QueueEntryCard";

/**
 * Reorderable plan queue (design D19, spec customer-portal "Reordering from the
 * page").
 *
 * Ordering is explicit: moving a card only changes local state, and nothing is sent
 * until "Lưu thứ tự" is pressed. That is what makes the 409 `queue_changed` path
 * meaningful — the customer's intent is submitted against a queue they saw.
 *
 * Accessibility is not bolted on:
 *   * @dnd-kit's KeyboardSensor makes the drag handle itself operable (Space to
 *     pick up, arrows to move, Space to drop);
 *   * every card ALSO gets ↑/↓ buttons labelled "Đưa gói <name> lên/xuống", which
 *     is the simplest possible path for a keyboard or switch user;
 *   * a polite live region announces the new position after every move, and again
 *     after a save.
 *
 * The component never computes eligibility: `entry.statusLabel` comes from the
 * server (queueViewSync), so the arrows and the request path agree.
 */
function MoveButton({ icon, label, disabled, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 border border-border bg-surface px-3 font-mono text-xs font-medium text-text-main transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="material-symbols-outlined text-[16px]" aria-hidden="true">{icon}</span>
      {children}
    </button>
  );
}

function SortableCard({ entry, index, total, onMove, renderActions }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const name = entry.planName || entry.planCode || "gói";

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  const handle = (
    <button
      type="button"
      {...attributes}
      {...listeners}
      aria-label={`Kéo để đổi thứ tự gói ${name}`}
      className="flex size-9 shrink-0 cursor-grab items-center justify-center border border-border bg-surface-2 text-text-muted transition-colors duration-150 hover:text-text-main active:cursor-grabbing"
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">drag_indicator</span>
    </button>
  );

  return (
    <li ref={setNodeRef} style={style} className="list-none">
      <QueueEntryCard
        entry={entry}
        position={index + 1}
        dragHandle={handle}
        renderActions={(item) => (
          <>
            <div className="flex items-center gap-1.5">
              <MoveButton
                icon="arrow_upward"
                label={`Đưa gói ${name} lên`}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                Lên
              </MoveButton>
              <MoveButton
                icon="arrow_downward"
                label={`Đưa gói ${name} xuống`}
                disabled={index === total - 1}
                onClick={() => onMove(index, index + 1)}
              >
                Xuống
              </MoveButton>
            </div>
            {renderActions ? renderActions(item) : null}
          </>
        )}
      />
    </li>
  );
}

export default function PlanQueue({
  entries = [],
  editable = true,
  onSave = null,
  renderActions = null,
  saving = false,
  error = "",
  className = "",
}) {
  const [order, setOrder] = useState(() => entries.map((entry) => entry.id));
  const [message, setMessage] = useState("");
  const liveId = useId();
  const byId = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);
  const lastEntriesRef = useRef(entries);

  // Re-sync when the server sends a new queue (after a save, a 409 reload, or a
  // poll). A save in flight keeps the local order so the UI does not jump under
  // the customer's hands.
  useEffect(() => {
    const nextIds = entries.map((entry) => entry.id);
    const prevIds = lastEntriesRef.current.map((entry) => entry.id);
    const changed = nextIds.length !== prevIds.length || nextIds.some((id, i) => id !== prevIds[i]);
    lastEntriesRef.current = entries;
    if (changed) setOrder(nextIds);
  }, [entries]);

  const savedOrder = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const dirty = order.length !== savedOrder.length || order.some((id, i) => id !== savedOrder[i]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const move = useCallback(
    (from, to) => {
      if (to < 0 || to >= order.length) return;
      setOrder((current) => {
        const next = arrayMove(current, from, to);
        const name = byId.get(next[to])?.planName || byId.get(next[to])?.planCode || "gói";
        setMessage(`${name} đã chuyển tới vị trí ${to + 1} trên ${next.length}`);
        return next;
      });
    },
    [order.length, byId]
  );

  const handleDragEnd = (event) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = order.indexOf(active.id);
    const to = order.indexOf(over.id);
    if (from === -1 || to === -1) return;
    move(from, to);
  };

  const cancel = () => {
    setOrder(savedOrder);
    setMessage("Đã hủy thay đổi thứ tự");
  };

  const save = async () => {
    if (!onSave) return;
    const orderedIds = [...order];
    const ok = await onSave(orderedIds);
    if (ok === true) {
      const names = orderedIds.map((id) => byId.get(id)?.planName || byId.get(id)?.planCode || "gói");
      setMessage(`Đã lưu thứ tự: ${names.join(" → ")}`);
    }
  };

  const orderedEntries = order.map((id) => byId.get(id)).filter(Boolean);

  if (entries.length === 0) {
    return (
      <div className={`flex flex-col gap-1 border border-dashed border-border px-6 py-10 ${className}`}>
        <p className="text-sm font-medium text-text-main">Hàng đợi đang trống</p>
        <p className="text-sm leading-6 text-text-muted">
          Mua một gói để bắt đầu. Credit của gói sẽ trả cho mọi model trong nhóm của bạn.
        </p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* One polite region for the whole queue: assistive tech hears the result of
          a move or a save without every card carrying its own announcement. */}
      <p id={liveId} aria-live="polite" className="sr-only">
        {message}
      </p>

      {editable ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={order} strategy={verticalListSortingStrategy}>
            <ul className="flex flex-col gap-3" aria-describedby={liveId}>
              {orderedEntries.map((entry, index) => (
                <SortableCard
                  key={entry.id}
                  entry={entry}
                  index={index}
                  total={orderedEntries.length}
                  onMove={move}
                  renderActions={renderActions}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      ) : (
        <ul className="flex flex-col gap-3">
          {orderedEntries.map((entry) => (
            <li key={entry.id} className="list-none">
              <QueueEntryCard entry={entry} renderActions={renderActions} />
            </li>
          ))}
        </ul>
      )}

      {/* Dirty-state bar: nothing is sent until the customer says so. */}
      {editable && dirty && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border border-text-main bg-surface px-4 py-3">
          <p className="text-sm font-medium text-text-main">Thứ tự đã thay đổi</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={cancel}
              disabled={saving}
              className="inline-flex h-8 items-center border border-transparent px-3 font-mono text-xs font-medium text-text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-text-main disabled:opacity-50"
            >
              Hủy
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              aria-busy={saving || undefined}
              className="inline-flex h-8 items-center gap-2 border border-text-main bg-text-main px-3 font-mono text-xs font-medium text-bg transition-colors duration-150 hover:bg-text-main/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <span className="material-symbols-outlined animate-spin text-[14px]" aria-hidden="true">progress_activity</span>}
              Lưu thứ tự
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger">
          <span className="material-symbols-outlined text-[14px] mt-0.5" aria-hidden="true">error</span>
          {error}
        </p>
      )}
    </div>
  );
}

PlanQueue.propTypes = {
  entries: PropTypes.array,
  editable: PropTypes.bool,
  onSave: PropTypes.func,
  renderActions: PropTypes.func,
  saving: PropTypes.bool,
  error: PropTypes.string,
  className: PropTypes.string,
};

SortableCard.propTypes = {
  entry: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  total: PropTypes.number.isRequired,
  onMove: PropTypes.func.isRequired,
  renderActions: PropTypes.func,
};
