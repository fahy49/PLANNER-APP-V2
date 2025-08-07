import React, { useEffect, useMemo, useRef, useState } from "react";
import { DndContext, DragOverlay, useSensor, useSensors, PointerSensor, rectIntersection } from "@dnd-kit/core";
import { arrayMove, SortableContext } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// --- Types ---
type GoalLevel = 'YEAR' | 'QUARTER' | 'MONTH';

type Goal = {
  id: string;
  title: string;
  color: string; // tailwind color token (bg-*)
  targetWeeklyHours: number;
  endImageUrl?: string;
  level: GoalLevel;
  parentId?: string;
};

type BlockTemplate = {
  id: string;
  title: string;
  defaultDurationMin: number;
  defaultGoalId?: string;
  icon?: string;
};

type ScheduledBlock = {
  id: string;
  dateISO: string; // YYYY-MM-DD
  startMinOfDay: number; // minutes since 00:00
  durationMin: number;
  templateId?: string;
  goalId?: string;
  note?: string;
};

// --- Helpers ---
const DAY_START_MIN = 8 * 60; // 08:00
const DAY_END_MIN = 24 * 60; // 24:00
const SNAP_MIN = 30;
const GRID_MINUTES = DAY_END_MIN - DAY_START_MIN; // 960
const SLOT_COUNT = GRID_MINUTES / SNAP_MIN; // 32

function minutesToLabel(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const h12 = ((h + 11) % 12) + 1;
  const ampm = h < 12 ? "AM" : "PM";
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function snapTo(mins: number, snap: number) {
  return Math.round(mins / snap) * snap;
}

const todayISO = new Date().toISOString().slice(0, 10);

// --- Sample Data (replace with persistence) ---
const initialGoals: Goal[] = [
  {
    id: "g-identity",
    title: "Identity App",
    color: "bg-indigo-600",
    targetWeeklyHours: 20,
    endImageUrl: undefined,
    level: 'YEAR',
  },
  {
    id: "g-fitness",
    title: "Fitness",
    color: "bg-emerald-600",
    targetWeeklyHours: 6,
    level: 'YEAR',
  },
  {
    id: "g-relationships",
    title: "Relationships",
    color: "bg-rose-600",
    targetWeeklyHours: 4,
    level: 'YEAR',
  },
  {
    id: "g-admin",
    title: "Admin",
    color: "bg-amber-600",
    targetWeeklyHours: 3,
    level: 'YEAR',
  },
];

const initialTemplates: BlockTemplate[] = [
  { id: "bt-deep", title: "Deep Work", defaultDurationMin: 90, defaultGoalId: "g-identity", icon: "🧠" },
  { id: "bt-ex", title: "Exercise", defaultDurationMin: 60, defaultGoalId: "g-fitness", icon: "🏃" },
  { id: "bt-breakfast", title: "Breakfast", defaultDurationMin: 20, icon: "🍳" },
  { id: "bt-lunch", title: "Lunch", defaultDurationMin: 30, icon: "🥗" },
  { id: "bt-dinner", title: "Dinner", defaultDurationMin: 30, icon: "🍽️" },
  { id: "bt-admin", title: "Admin", defaultDurationMin: 30, defaultGoalId: "g-admin", icon: "🗂️" },
];

// --- Storage Keys ---
const LS_KEY = 'planner_v1_state';

type AppState = {
  goals: Goal[];
  templates: BlockTemplate[];
  blocks: ScheduledBlock[];
};

function loadState(): AppState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  // default empty day
  return { goals: initialGoals, templates: initialTemplates, blocks: [] };
}

function saveState(s: AppState) {
  localStorage.setItem(LS_KEY, JSON.stringify(s));
}

// --- UI Components ---
function GoalRibbon({ goals }: { goals: Goal[] }) {
  const total = goals.reduce((acc, g) => acc + (g.targetWeeklyHours || 0), 0) || 1;
  return (
    <div className="w-full rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
      <div className="px-4 pt-3 pb-2 text-sm text-zinc-600">Year Goals</div>
      <div className="flex w-full h-24">
        {goals.map((g) => {
          const pct = Math.round(((g.targetWeeklyHours || 0) / total) * 100);
          return (
            <div key={g.id} className="relative h-full" style={{ width: `${pct}%` }}>
              <div className={`absolute inset-0 ${g.color} opacity-90`} />
              <div className="absolute inset-0 p-3 flex flex-col justify-between text-white">
                <div className="text-sm font-semibold leading-tight drop-shadow">{g.title}</div>
                <div className="text-xs opacity-90 drop-shadow">{pct}% · {g.targetWeeklyHours}h/wk</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Palette({ templates, goals, onAdd }: { templates: BlockTemplate[]; goals: Goal[]; onAdd: (tpl: BlockTemplate) => void }) {
  const goalMap = useMemo(() => Object.fromEntries(goals.map(g => [g.id, g])), [goals]);
  return (
    <div className="w-64 shrink-0 h-full flex flex-col gap-3">
      <div className="text-sm font-medium text-zinc-700">Blocks</div>
      <div className="grid grid-cols-1 gap-2">
        {templates.map(tpl => (
          <button key={tpl.id} onClick={() => onAdd(tpl)} className="group flex items-center gap-3 rounded-xl border border-zinc-200 bg-white p-3 hover:shadow">
            <div className="text-lg">{tpl.icon || '⏱️'}</div>
            <div className="text-left">
              <div className="text-sm font-medium leading-tight">{tpl.title}</div>
              <div className="text-xs text-zinc-500">{tpl.defaultDurationMin} min{tpl.defaultGoalId ? ` · ${(goalMap[tpl.defaultGoalId]?.title || '')}` : ''}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TimeGrid({
  blocks,
  goals,
  onBlockChange,
  onBlockMove,
}: {
  blocks: ScheduledBlock[];
  goals: Goal[];
  onBlockChange: (id: string, next: Partial<ScheduledBlock>) => void;
  onBlockMove: (id: string, newStartMin: number) => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } })
  );

  const goalMap = useMemo(() => Object.fromEntries(goals.map(g => [g.id, g])), [goals]);

  function positionToStartMin(clientX: number, clientY: number) {
    const grid = gridRef.current;
    if (!grid) return DAY_START_MIN;
    const rect = grid.getBoundingClientRect();
    const y = clamp(clientY - rect.top, 0, rect.height);
    const slotH = rect.height / SLOT_COUNT; // vertical layout
    const slotIndex = Math.floor(y / slotH);
    const minsFromStart = slotIndex * SNAP_MIN;
    return clamp(DAY_START_MIN + minsFromStart, DAY_START_MIN, DAY_END_MIN - SNAP_MIN);
  }

  function handleDragStart(e: any) {
    setDraggingId(e.active.id as string);
  }
  function handleDragEnd(e: any) {
    const { active, delta, activatorEvent } = e;
    const id = active.id as string;
    if (!gridRef.current) return setDraggingId(null);

    // Move to nearest slot based on final pointer position
    const evt = activatorEvent as PointerEvent | MouseEvent | TouchEvent;
    let clientY = 0;
    // Best-effort pointer extraction
    if ('clientY' in evt && typeof (evt as any).clientY === 'number') {
      clientY = (evt as MouseEvent).clientY;
    } else if ('touches' in (evt as TouchEvent) && (evt as TouchEvent).touches[0]) {
      clientY = (evt as TouchEvent).touches[0].clientY;
    }
    const newStart = positionToStartMin(0, clientY);
    onBlockMove(id, newStart);
    setDraggingId(null);
  }

  // Sort blocks visually by start time
  const sorted = [...blocks].sort((a,b) => a.startMinOfDay - b.startMinOfDay);

  return (
    <DndContext sensors={sensors} collisionDetection={rectIntersection} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="relative flex-1 grid grid-cols-[100px_1fr] gap-4">
        {/* Time labels */}
        <div className="select-none">
          {Array.from({ length: SLOT_COUNT + 1 }).map((_, i) => {
            const mins = DAY_START_MIN + i * SNAP_MIN;
            const topPct = (i / SLOT_COUNT) * 100;
            return (
              <div key={i} className="absolute left-0" style={{ top: `${topPct}%` }}>
                <div className="-translate-y-1/2 text-xs text-zinc-500">{minutesToLabel(mins)}</div>
              </div>
            );
          })}
        </div>

        {/* Grid area */}
        <div ref={gridRef} className="relative h-[960px] rounded-xl border border-zinc-200 bg-white shadow-sm overflow-hidden">
          {/* horizontal slot lines */}
          {Array.from({ length: SLOT_COUNT }).map((_, i) => (
            <div key={i} className="absolute left-0 right-0 h-px bg-zinc-100" style={{ top: `${(i / SLOT_COUNT) * 100}%` }} />
          ))}

          {/* Blocks */}
          {sorted.map((b) => {
            const goal = b.goalId ? goalMap[b.goalId] : undefined;
            const top = ((b.startMinOfDay - DAY_START_MIN) / GRID_MINUTES) * 100;
            const height = (b.durationMin / GRID_MINUTES) * 100;
            return (
              <DraggableBlock
                key={b.id}
                id={b.id}
                title={b.note || ''}
                label={b.templateId || ''}
                color={goal?.color || 'bg-zinc-400'}
                topPct={top}
                heightPct={height}
                durationMin={b.durationMin}
                onResize={(nextDuration: number) => onBlockChange(b.id, { durationMin: nextDuration })}
              >
                <div className="text-xs font-medium">{b.note || b.label || 'Block'}</div>
                <div className="text-[10px] opacity-80">{minutesToLabel(b.startMinOfDay)} → {minutesToLabel(b.startMinOfDay + b.durationMin)}</div>
              </DraggableBlock>
            );
          })}
        </div>
      </div>
      <DragOverlay />
    </DndContext>
  );
}

function DraggableBlock({ id, title, label, color, topPct, heightPct, durationMin, onResize, children }: any) {
  // Minimal draggable/resizable without full dnd-kit Sortable for brevity
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState<null | 'start' | 'end'>(null);
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      id={id}
      ref={ref}
      className={`absolute left-2 right-2 rounded-lg text-white shadow ${color} ${dragging ? 'opacity-80' : ''}`}
      style={{ top: `${topPct}%`, height: `${heightPct}%` }}
      onPointerDown={(e) => { setDragging(true); }}
      onPointerUp={(e) => { setDragging(false); setResizing(null); }}
    >
      {/* content */}
      <div className="p-2 text-xs leading-tight select-none">
        {children}
      </div>
      {/* resize handles */}
      <div
        className="absolute -top-1 left-3 right-3 h-2 cursor-ns-resize"
        onPointerDown={(e) => { e.stopPropagation(); setResizing('start'); }}
      />
      <div
        className="absolute -bottom-1 left-3 right-3 h-2 cursor-ns-resize"
        onPointerDown={(e) => { e.stopPropagation(); setResizing('end'); }}
      />
    </div>
  );
}

export default function PlannerApp() {
  const [state, setState] = useState<AppState>(() => (typeof window !== 'undefined' ? loadState() : { goals: initialGoals, templates: initialTemplates, blocks: [] }));
  const [dateISO, setDateISO] = useState<string>(todayISO);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    saveState(state);
  }, [state]);

  const dayBlocks = useMemo(() => state.blocks.filter(b => b.dateISO === dateISO), [state.blocks, dateISO]);

  const addTemplateToDay = (tpl: BlockTemplate) => {
    const id = `b-${Math.random().toString(36).slice(2,9)}`;
    const newBlock: ScheduledBlock = {
      id,
      dateISO,
      startMinOfDay: DAY_START_MIN,
      durationMin: tpl.defaultDurationMin,
      templateId: tpl.title,
      goalId: tpl.defaultGoalId,
      note: tpl.title,
    };
    setState(s => ({ ...s, blocks: [...s.blocks, newBlock] }));
  };

  const moveBlock = (id: string, newStart: number) => {
    newStart = snapTo(newStart, SNAP_MIN);
    setState(s => ({ ...s, blocks: s.blocks.map(b => b.id === id ? { ...b, startMinOfDay: newStart } : b) }));
  };

  const changeBlock = (id: string, next: Partial<ScheduledBlock>) => {
    setState(s => ({ ...s, blocks: s.blocks.map(b => b.id === id ? { ...b, ...next } : b) }));
  };

  const totalsByGoal = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of dayBlocks) {
      const g = b.goalId || 'none';
      map.set(g, (map.get(g) || 0) + b.durationMin);
    }
    return map;
  }, [dayBlocks]);

  const goals = state.goals;

  return (
    <div className="min-h-screen w-full bg-zinc-50 p-6">
      <div className="max-w-6xl mx-auto flex flex-col gap-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="text-xl font-semibold">Planner v1</div>
          <div className="flex items-center gap-3">
            <input type="date" className="rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm" value={dateISO} onChange={(e) => setDateISO(e.target.value)} />
            <div className="text-sm text-zinc-600">Snap: 30m · Overlap: allowed</div>
          </div>
        </div>

        {/* Goal Ribbon */}
        <GoalRibbon goals={goals} />

        <div className="flex gap-6">
          {/* Palette */}
          <Palette templates={state.templates} goals={goals} onAdd={addTemplateToDay} />

          {/* Day Grid */}
          <div className="flex-1">
            <TimeGrid blocks={dayBlocks} goals={goals} onBlockChange={changeBlock} onBlockMove={moveBlock} />

            {/* Totals Bar */}
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-3 shadow-sm">
              <div className="text-sm font-medium text-zinc-700 mb-2">Totals (today)</div>
              <div className="flex flex-wrap gap-3 text-sm">
                {goals.map(g => {
                  const mins = totalsByGoal.get(g.id) || 0;
                  const hrs = (mins / 60).toFixed(1);
                  return (
                    <div key={g.id} className="flex items-center gap-2">
                      <span className={`inline-block h-3 w-3 rounded ${g.color}`} />
                      <span>{g.title}: {hrs}h</span>
                    </div>
                  );
                })}
                {/* none goal */}
                {totalsByGoal.get('none') ? (
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-3 w-3 rounded bg-zinc-400`} />
                    <span>Unassigned: {( (totalsByGoal.get('none')||0) / 60).toFixed(1)}h</span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
