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
import { Button } from "@/shared/components";
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
      className="mt-0.5 flex size-8 shrink-0 items-center justify-center border border-border text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors duration-150 cursor-grab active:cursor-grabbing"
    >
      <span className="material-symbols-outlined text-[18px]" aria-hidden="true">drag_indicator</span>
    </button>
  );

  return (
    <li ref={setNodeRef} style={style} className="list-none">
      <QueueEntryCard
        entry={entry}
        dragHandle={handle}
        renderActions={(item) => (
          <>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon="arrow_upward"
                aria-label={`Đưa gói ${name} lên`}
                disabled={index === 0}
                onClick={() => onMove(index, index - 1)}
              >
                Lên
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                icon="arrow_downward"
                aria-label={`Đưa gói ${name} xuống`}
                disabled={index === total - 1}
                onClick={() => onMove(index, index + 1)}
              >
                Xuống
              </Button>
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
    setMessage("Đã huỷ thay đổi thứ tự");
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
      <div className={`border border-border bg-surface px-6 py-10 ${className}`}>
        <p className="text-text-main font-medium">Hàng đợi đang trống</p>
        <p className="mt-1 text-sm text-text-muted">
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
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border border-brand-500/40 bg-surface px-4 py-3">
          <p className="text-sm text-text-main">Thứ tự đã thay đổi</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
              Huỷ
            </Button>
            <Button size="sm" onClick={save} loading={saving} disabled={saving}>
              Lưu thứ tự
            </Button>
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
